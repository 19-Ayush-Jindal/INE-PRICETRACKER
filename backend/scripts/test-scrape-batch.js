// scripts/test-scrape-batch.js
//
// A small, disposable test harness for checking that /api/cron/scrape-all's
// concurrency actually works, without waiting for a real 2-hour cycle or
// tracking dozens of products by hand first.
//
// What it does:
//   1. Takes the first N products (default 10) from your local
//      product-index.json.
//   2. Makes sure they're in tracked_products (harmless if they already are
//      - ON CONFLICT DO NOTHING, same as the startup seeding).
//   3. Calls your ALREADY-RUNNING backend's POST /api/cron/scrape-all over
//      HTTP (exactly the same call cron-job.org would make) and times how
//      long the whole thing takes.
//
// Usage (run from the backend/ folder, with `npm start` already running in
// another terminal):
//   npm run test-scrape           -> tests the first 10 products
//   npm run test-scrape -- 20     -> tests the first 20 products instead
//
// What to look for:
//   - The reported time should be roughly (N / SCRAPE_CONCURRENCY) * time-per-product,
//     NOT N * time-per-product. E.g. 10 products at ~15s each: sequentially
//     that's ~150s, but at concurrency 3 it should land closer to ~50-60s.
//   - The SQL query printed at the end shows each product's scrape_log rows
//     for this run - if several different products' started_at timestamps
//     overlap (rather than each one starting only after the previous
//     finished), that's direct proof several scrapes were genuinely running
//     at the same time, not just claimed to be.

require('dotenv').config();
const { pool } = require('../db');
const { PRODUCTS } = require('../products');

const COUNT = Number(process.argv[2]) || 10;
const PORT = process.env.PORT || 4000;
const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${PORT}`;

async function main() {
  if (!process.env.CRON_SECRET) {
    throw new Error('CRON_SECRET is not set in your .env - this script needs it to call the cron endpoint.');
  }

  const productsToTest = PRODUCTS.slice(0, COUNT);
  if (productsToTest.length === 0) {
    throw new Error('No products found in product-index.json - run "npm run build-index" first.');
  }

  console.log(
    `Testing a scrape-all run with ${productsToTest.length} product(s): ` +
      productsToTest.map((p) => `${p.id} (${p.name})`).join(', ')
  );

  // Make sure exactly these products are tracked. Harmless if they already
  // are (this is the SAME statement server.js's startup seeding uses) -
  // does NOT touch or reset any existing history for them.
  for (const product of productsToTest) {
    await pool.query(
      `INSERT INTO tracked_products (product_id, product_name)
       VALUES ($1, $2)
       ON CONFLICT (product_id) DO NOTHING`,
      [product.id, product.name]
    );
  }

  // IMPORTANT: without productIds, /api/cron/scrape-all scrapes EVERY
  // tracked product - and since the server seeds the whole ~1,000-product
  // catalog into tracked_products at startup, that would mean this "test
  // with 10 products" call would actually kick off a scrape of all ~1,000
  // of them (and take well over an hour), not just the 10 requested here.
  // Passing productIds scopes the endpoint down to exactly this test batch.
  const productIdsParam = productsToTest.map((p) => p.id).join(',');

  const runStartedAt = new Date();
  console.log(`\nCalling POST ${BASE_URL}/api/cron/scrape-all (scoped to ${productsToTest.length} product(s)) ...`);
  const startedAtMs = Date.now();

  const response = await fetch(
    `${BASE_URL}/api/cron/scrape-all?secret=${encodeURIComponent(process.env.CRON_SECRET)}&productIds=${encodeURIComponent(
      productIdsParam
    )}`,
    {
      method: 'POST',
    }
  );
  const body = await response.json().catch(() => ({}));
  const elapsedSeconds = ((Date.now() - startedAtMs) / 1000).toFixed(1);

  if (!response.ok) {
    throw new Error(`Request failed (HTTP ${response.status}): ${JSON.stringify(body)}`);
  }

  console.log(`\nDone in ${elapsedSeconds}s, concurrency was ${body.concurrency}.`);
  console.log('Per-product results:');
  for (const result of body.results) {
    console.log(`  ${result.productId}: ${result.ok ? `OK - ₹${result.price}` : `FAILED - ${result.error}`}`);
  }

  // Pull this run's actual scrape_log rows so you can SEE the overlap
  // directly, not just trust the total time.
  const { rows: logRows } = await pool.query(
    `SELECT product_id, attempt_number, status, started_at, duration_ms
     FROM scrape_log
     WHERE product_id = ANY($1) AND started_at >= $2
     ORDER BY started_at ASC`,
    [productsToTest.map((p) => p.id), runStartedAt]
  );

  console.log('\nAttempt timeline (look for overlapping started_at times across DIFFERENT product_ids):');
  for (const row of logRows) {
    console.log(
      `  ${row.started_at.toISOString()}  product ${row.product_id}  attempt ${row.attempt_number}  ${row.status}  (${row.duration_ms}ms)`
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error('test-scrape-batch failed:', err.message);
  process.exit(1);
});
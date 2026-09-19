// server.js
//
// The Express API. Routes fall into three groups:
//   1. Product search + tracking      -> used by the React frontend
//   2. Price history + scrape log     -> also used by the frontend, to draw
//                                        the chart and the attempts table
//   3. The cron-triggered scrape      -> called by cron-job.org every 2
//                                        hours, NOT by the frontend
//
// Why a cron-triggered ENDPOINT instead of a setInterval() running inside
// this process: Render's free tier puts the service to sleep when it's had
// no traffic for a while. An in-process timer would simply stop firing
// while asleep. An external cron service instead makes an HTTP request to
// wake the service up and run one scrape cycle - so the schedule keeps
// working even though the server itself doesn't run continuously.

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const { pool } = require('./db');
const { PRODUCTS, searchProducts, findProductById } = require('./products');
const { scrapeProductWithRetries } = require('./scraper');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

/**
 * Makes sure every product we know about (the whole local index, not just
 * ones a user has searched for) has a row in tracked_products, so that
 * /api/cron/scrape-all's periodic scrape covers ALL of them from day one -
 * not just the ones someone happened to click on first.
 *
 * Why this matters: price_history and scrape_log both point at
 * tracked_products (that's what the two tables' foreign keys reference), so
 * "does this product have any history yet" was previously entirely down to
 * whether a user had ever tracked it. A product nobody had searched for yet
 * would show an empty chart even though the store has had a real price the
 * whole time. Seeding tracked_products with the full index at startup means
 * every product starts accumulating history on the very first scheduled
 * scrape, regardless of whether/when a user ever picks it from the dropdown.
 *
 * ON CONFLICT DO NOTHING makes this safe to run every time the server
 * starts (Render restarts it on every deploy, and can restart it after
 * sleeping) - existing rows, and their history, are left untouched.
 */
async function seedAllKnownProductsAsTracked() {
  if (PRODUCTS.length === 0) return;

  // One INSERT for every product, not one INSERT PER product. The store's
  // real catalog turned out to be ~1,000 products, not the handful this was
  // first written and tested against - at that size, looping a single
  // `pool.query()` per product (1,000 sequential network round-trips) was
  // slow enough to blow past even a generous startup timeout on its own,
  // with nothing actually wrong with the database connection itself.
  // unnest() turns two plain arrays (ids, names) into a set of rows Postgres
  // can INSERT ... SELECT FROM in a single round-trip, regardless of how
  // many products there are.
  const ids = PRODUCTS.map((product) => product.id);
  const names = PRODUCTS.map((product) => product.name);

  await pool.query(
    `INSERT INTO tracked_products (product_id, product_name)
     SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (product_id) DO NOTHING`,
    [ids, names]
  );

  console.log(`Seeded ${PRODUCTS.length} product(s) from product-index.json into tracked_products.`);
}

// ---------------------------------------------------------------------
// 1. Product search + tracking
// ---------------------------------------------------------------------

// GET /api/products/search?q=spea
// Powers the search box's dropdown. Searches the local product index, not
// the live site - the store has no product-search API of its own.
app.get('/api/products/search', (req, res) => {
  const results = searchProducts(req.query.q, 10);
  res.json({ results });
});

// GET /api/tracked
// Everything the user is currently tracking, for the "your tracked
// products" list on the frontend.
app.get('/api/tracked', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM tracked_products ORDER BY added_at DESC');
  res.json({ tracked: rows });
});

// POST /api/tracked   body: { productId }
// Adds a product to the tracked list (if it isn't already tracked) and
// immediately runs one scrape for it, so the user sees a first data point
// right away instead of waiting up to 2 hours for the next cron run.
app.post('/api/tracked', async (req, res) => {
  const { productId } = req.body || {};
  if (!productId) return res.status(400).json({ error: 'productId is required' });

  const product = findProductById(productId);
  if (!product) return res.status(404).json({ error: `No known product with id ${productId}` });

  await pool.query(
    `INSERT INTO tracked_products (product_id, product_name)
     VALUES ($1, $2)
     ON CONFLICT (product_id) DO NOTHING`,
    [product.id, product.name]
  );

  try {
    const result = await scrapeOneProductAndRecord(product.id, product.name);
    res.json({ tracked: product, firstScrape: result });
  } catch (err) {
    // The product IS tracked even though this first scrape failed - the
    // scheduled job will pick it up on its next run. Say so honestly
    // rather than pretending everything succeeded.
    res.json({ tracked: product, firstScrape: null, firstScrapeError: err.message });
  }
});

// ---------------------------------------------------------------------
// 2. Price history + scrape log (read-only, for the frontend charts/tables)
// ---------------------------------------------------------------------

// GET /api/products/:id/history
app.get('/api/products/:id/history', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT price, deal_price, mrp, in_stock, fetched_at
     FROM price_history
     WHERE product_id = $1
     ORDER BY fetched_at ASC`,
    [req.params.id]
  );
  res.json({ history: rows });
});

// GET /api/products/:id/logs
app.get('/api/products/:id/logs', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT run_id, attempt_number, status, http_status, message, duration_ms, started_at
     FROM scrape_log
     WHERE product_id = $1
     ORDER BY started_at DESC
     LIMIT 200`,
    [req.params.id]
  );
  res.json({ logs: rows });
});

// ---------------------------------------------------------------------
// 3. The scheduled scrape, triggered by an external cron service
// ---------------------------------------------------------------------

// How many products to scrape at once during a scheduled batch. Each one
// spins up its own headless Chromium (see scrapeOneProductAndRecord), and
// Chromium's memory footprint - not wall-clock time - is what actually
// limits this on a free-tier instance. Purely sequential (concurrency 1)
// doesn't scale: at ~15-20s per product, a few hundred products would blow
// well past a 2-hour window. But running every product's browser at once
// would just as easily run a small free-tier instance out of memory. A
// small, fixed concurrency limit is the practical middle ground - override
// with the SCRAPE_CONCURRENCY env var if a bigger instance can take more.
const SCRAPE_CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY) || 3;

/**
 * Runs `worker(item)` for every item in `items`, at most `limit` at a time,
 * and returns the settled results in the SAME order as `items` (not the
 * order they finished in) - a small hand-rolled worker pool, since pulling
 * in a whole library (e.g. p-limit) for this one loop would be one more
 * dependency to explain for something this short.
 */
async function mapWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  // Kick off up to `limit` workers, each of which keeps pulling the next
  // unstarted item off the shared `nextIndex` counter until none are left -
  // this naturally keeps exactly `limit` scrapes in flight without any
  // fixed-size chunking (a slow product doesn't block a whole "batch").
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runNext));

  return results;
}

// POST /api/cron/scrape-all?secret=...
// cron-job.org (or any scheduler) hits this every 2 hours. It scrapes every
// tracked product, up to SCRAPE_CONCURRENCY at a time (see above) rather
// than strictly one at a time - important once the tracked list gets large
// enough that sequential scraping wouldn't finish within the 2-hour window.
//
// Optional ?productIds=1,2,3 query param: restricts the run to just those
// ids, purely so this can be manually tested against a small handful of
// products (see scripts/test-scrape-batch.js) without waiting for - or
// accidentally kicking off - a scrape of the ENTIRE tracked list, which at
// this store's real catalog size (~1,000 products) takes well over an hour
// even with concurrency. The real cron-job.org trigger never sends this
// param, so its behavior (scrape everything) is unchanged.
app.post('/api/cron/scrape-all', async (req, res) => {
  const providedSecret = req.query.secret || req.get('x-cron-secret');
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Missing or incorrect cron secret' });
  }

  const { rows: allTrackedProducts } = await pool.query('SELECT product_id, product_name FROM tracked_products');

  let trackedProducts = allTrackedProducts;
  if (req.query.productIds) {
    const requestedIds = new Set(
      String(req.query.productIds)
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    );
    trackedProducts = allTrackedProducts.filter((product) => requestedIds.has(product.product_id));
  }

  const results = await mapWithConcurrencyLimit(trackedProducts, SCRAPE_CONCURRENCY, async (product) => {
    try {
      const result = await scrapeOneProductAndRecord(product.product_id, product.product_name);
      return { productId: product.product_id, ok: true, price: result.price };
    } catch (err) {
      // Deliberately still recorded above (scrapeOneProductAndRecord writes
      // to scrape_log even on failure) - this catch is just so ONE
      // product's total failure doesn't stop the rest of the batch.
      return { productId: product.product_id, ok: false, error: err.message };
    }
  });

  res.json({ scrapedAt: new Date().toISOString(), concurrency: SCRAPE_CONCURRENCY, results });
});

// POST /api/cron/cleanup-logs?secret=...&days=7
// Deletes scrape_log rows older than `days` (default 7). This is separate
// from /api/cron/scrape-all and meant to be triggered on its own, much
// less frequent schedule (e.g. once a day) via cron-job.org.
//
// Why this exists: scrape_log gets a row per ATTEMPT, not per scrape - up
// to 4 rows per product per run (see scrapeProductWithRetries's maxAttempts).
// At this store's real catalog size (~1,000 products) scraped every 2
// hours, that's potentially tens of thousands of new rows a day. Old
// attempt logs stop being useful pretty quickly - nobody needs to know
// exactly how a scrape attempt 3 weeks ago failed - but unlike
// price_history (the actual data the chart is built from, and small: one
// row per product per successful run, never deleted here), there's no
// reason to keep scrape_log rows forever. This keeps the table from
// growing without bound on a free-tier database that has a real storage
// cap.
app.post('/api/cron/cleanup-logs', async (req, res) => {
  const providedSecret = req.query.secret || req.get('x-cron-secret');
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Missing or incorrect cron secret' });
  }

  const retentionDays = Number(req.query.days) || 7;
  const { rowCount } = await pool.query(
    `DELETE FROM scrape_log WHERE started_at < now() - ($1 || ' days')::interval`,
    [retentionDays]
  );

  res.json({ deletedRows: rowCount, retentionDays });
});

// Manual single-product trigger, handy for testing from the frontend or
// curl without waiting for the 2-hour schedule. Same underlying logic as
// the cron route, just for one product on demand.
app.post('/api/products/:id/scrape-now', async (req, res) => {
  const product = findProductById(req.params.id);
  if (!product) return res.status(404).json({ error: `No known product with id ${req.params.id}` });

  try {
    const result = await scrapeOneProductAndRecord(product.id, product.name);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

/**
 * Runs one full (retried) scrape for a product, writes every attempt to
 * scrape_log, and - only on success - writes the resulting reading to
 * price_history. Never writes a price_history row for a failed run; the
 * scrape_log is what shows failures happened.
 */
async function scrapeOneProductAndRecord(productId, productName) {
  const runId = crypto.randomUUID();
  const browser = await chromium.launch({ headless: true });

  try {
    const result = await scrapeProductWithRetries(browser, productId, {
      maxAttempts: 4,
      onAttempt: (attempt) => {
        // Fire-and-forget logging - we don't want a slow DB write to hold
        // up the scrape itself. Errors here are logged, not thrown.
        pool
          .query(
            `INSERT INTO scrape_log (product_id, run_id, attempt_number, status, http_status, message, duration_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [productId, runId, attempt.attemptNumber, attempt.status, attempt.httpStatus, attempt.message, attempt.durationMs]
          )
          .catch((err) => console.error('Failed to write scrape_log row:', err));
      },
    });

    await pool.query(
      `INSERT INTO price_history (product_id, price, deal_price, mrp, in_stock)
       VALUES ($1, $2, $3, $4, $5)`,
      [productId, result.price, result.dealPrice, result.mrp, result.inStock]
    );

    // Keep the tracked product's display name fresh in case it ever
    // changes on the store.
    if (productName && result.productName && productName !== result.productName) {
      await pool.query('UPDATE tracked_products SET product_name = $1 WHERE product_id = $2', [
        result.productName,
        productId,
      ]);
    }

    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

// Seed tracked_products with the full index BEFORE accepting traffic, so
// there's no window where a request could race the seed (e.g. a cron run
// firing before startup finishes). If the seed fails (e.g. DB briefly
// unreachable on boot), we still start the server rather than crash-looping
// forever - the next cron run, or a manual /api/tracked call, still works.
//
// This is wrapped in a hard timeout as well as a .catch(): a rejected
// promise is handled by .catch(), but a bad PG_CONNECTION_STRING can make
// the underlying `pg` connection attempt HANG rather than reject (no error,
// no timeout, nothing printed) - db.js now sets connectionTimeoutMillis to
// guard against that at the connection level, but this timeout is a second,
// independent safety net specifically so a broken DB can never again make
// the whole server look like it's silently stuck on startup with zero
// output, which is exactly what happened before this was added.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

withTimeout(seedAllKnownProductsAsTracked(), 20000, 'Seeding tracked_products')
  .catch((err) => console.error('Failed to seed tracked_products at startup:', err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Price tracker API listening on port ${PORT}`);
    });
  });
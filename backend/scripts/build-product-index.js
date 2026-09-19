// scripts/build-product-index.js
//
// A one-time (or occasional re-run) utility: visits /product/1, /product/2,
// ... up to MAX_ID on the store and records each product's name + category,
// writing the result to product-index.json. products.js then loads that
// file to power the search box - this is the "index the store and map
// names to ids" step done automatically instead of by hand.
//
// Usage:
//   node scripts/build-product-index.js            (scans ids 1-40)
//   node scripts/build-product-index.js 60          (scans ids 1-60)
//
// Re-run this occasionally if the store adds new products.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { dismissCookieBannerIfPresent } = require('../scraper');

const BASE_URL = 'https://demo.inelabteamdev.com';
const MAX_ID = Number(process.argv[2]) || 40;
const OUTPUT_PATH = path.join(__dirname, '..', 'product-index.json');

// A single, unretried attempt at loading /product/:id and reading its
// title. Returns null for "this attempt didn't find a product" - which the
// caller (readProductPage) does NOT treat as gospel, because this store
// injects the same kind of occasional flakiness into plain page loads that
// it injects into the price API (random slow renders, the cookie banner
// stealing the moment right after navigation, occasional error responses).
// A single failed attempt here is not reliable evidence the product doesn't
// exist - see readProductPage below for the retry that actually decides
// that.
async function attemptReadProductPage(page, id) {
  const response = await page.goto(`${BASE_URL}/product/${id}`, {
    waitUntil: 'networkidle',
    timeout: 15000,
  });

  if (response && response.status() >= 400) return null;

  // Give the cookie banner a moment to mount before checking for it, same
  // as the main scraper does - it isn't always present on the very first
  // paint.
  await page.waitForTimeout(300);
  await dismissCookieBannerIfPresent(page);

  const name = await page.locator('h1').first().innerText({ timeout: 8000 }).catch(() => null);
  if (!name) return null;

  const category = await page.locator('.tile-category').first().innerText().catch(() => null);

  return { id: String(id), name: name.trim(), category: category ? category.trim() : null };
}

/**
 * Tries a product page up to `maxAttempts` times before concluding it
 * genuinely doesn't exist. This mirrors why backend/scraper.js retries the
 * price reveal: one failed attempt on this site can mean "the product
 * doesn't exist" OR just "this particular load hit a slow render / stray
 * error / the cookie banner in the way" - and without a retry, those two
 * looked identical, which was silently dropping real products from the
 * index (e.g. id 51 came back "not found" on the first pass here despite
 * genuinely existing on the site).
 */
async function readProductPage(page, id, { maxAttempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const product = await attemptReadProductPage(page, id);
      if (product) return product;
      // Got a clean "no title rendered" result, not a thrown error - still
      // worth a retry before giving up, for the reasons above.
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxAttempts) {
      await page.waitForTimeout(500 * attempt); // small backoff, same idea as the scraper's retries
    }
  }
  if (lastError) {
    // Every attempt threw - surface that distinctly in the log line below
    // rather than pretending it was a clean "not found".
    throw lastError;
  }
  return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const found = [];
  let consecutiveMisses = 0;

  for (let id = 1; id <= MAX_ID; id++) {
    process.stdout.write(`checking product ${id}... `);
    try {
      const product = await readProductPage(page, id);
      if (product) {
        console.log(`found: "${product.name}" (${product.category || 'uncategorised'})`);
        found.push(product);
        consecutiveMisses = 0;
      } else {
        console.log('not found (after retries - likely does not exist)');
        consecutiveMisses++;
      }
    } catch (err) {
      console.log(`error (${err.message})`);
      consecutiveMisses++;
    }

    // If we hit 5 misses in a row, we're almost certainly past the end of
    // the catalog - stop scanning instead of grinding through every
    // remaining id up to MAX_ID.
    if (consecutiveMisses >= 5) {
      console.log('5 misses in a row - assuming that is the end of the catalog.');
      break;
    }
  }

  await browser.close();

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(found, null, 2));
  console.log(`\nWrote ${found.length} products to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('build-product-index failed:', err);
  process.exit(1);
});


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


async function seedAllKnownProductsAsTracked() {
  if (PRODUCTS.length === 0) return;


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


app.get('/api/products/search', (req, res) => {
  const results = searchProducts(req.query.q, 10);
  res.json({ results });
});


app.get('/api/tracked', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM tracked_products ORDER BY added_at DESC');
  res.json({ tracked: rows });
});

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

    res.json({ tracked: product, firstScrape: null, firstScrapeError: err.message });
  }
});


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


const SCRAPE_CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY) || 3;


async function mapWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }


  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runNext));

  return results;
}


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


  const batchRunId = crypto.randomUUID();

  const results = await mapWithConcurrencyLimit(trackedProducts, SCRAPE_CONCURRENCY, async (product) => {
    try {
      const result = await scrapeOneProductAndRecord(product.product_id, product.product_name, batchRunId);
      return { productId: product.product_id, ok: true, price: result.price };
    } catch (err) {
      return { productId: product.product_id, ok: false, error: err.message };
    }
  });

  res.json({ scrapedAt: new Date().toISOString(), runId: batchRunId, concurrency: SCRAPE_CONCURRENCY, results });
});


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


async function scrapeOneProductAndRecord(productId, productName, sharedRunId = null) {
  const runId = sharedRunId || crypto.randomUUID();
  const browser = await chromium.launch({ headless: true });

  try {
    const result = await scrapeProductWithRetries(browser, productId, {
      maxAttempts: 4,
      onAttempt: (attempt) => {

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
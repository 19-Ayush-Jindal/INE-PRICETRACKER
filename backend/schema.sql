-- Run this once against your Supabase (Postgres) database, e.g. by pasting
-- it into the Supabase SQL editor, or with:
--   psql "$PG_CONNECTION_STRING" -f schema.sql

-- Every product we scrape on the 2-hour schedule. In practice this ends up
-- containing the WHOLE local product index (see server.js's
-- seedAllKnownProductsAsTracked, run at startup), not only products a user
-- has explicitly picked from the dropdown - that way every product already
-- has price history by the time anyone searches for it, instead of only
-- starting to accumulate history from whenever it happened to first get
-- tracked.
CREATE TABLE IF NOT EXISTS tracked_products (
  product_id    TEXT PRIMARY KEY,       -- the id from the store's own URL, e.g. '3'
  product_name  TEXT NOT NULL,          -- e.g. 'Larkspur Speaker Pro' - shown in the UI
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per SUCCESSFUL price/stock reading. This is what the chart on the
-- frontend reads from - only real, correctly-parsed data points ever land
-- here, never a guess or a partial result from a failed attempt.
CREATE TABLE IF NOT EXISTS price_history (
  id            SERIAL PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES tracked_products(product_id) ON DELETE CASCADE,
  price         NUMERIC NOT NULL,       -- the actual selling price shown on the page
  deal_price    NUMERIC,                -- the "Deal price" strike-through step, when shown
  mrp           NUMERIC,                -- the original MRP (highest, struck-through) price
  in_stock      INTEGER,                -- units left, when the page shows a number
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per scrape ATTEMPT (not just the final outcome) - this is what
-- "never hide a failure" means in practice. A single scheduled run for one
-- product can produce several rows here: e.g. 'retried', 'retried', then
-- 'success' - or several 'retried' rows followed by 'failed' if it never
-- recovers.
CREATE TABLE IF NOT EXISTS scrape_log (
  id              SERIAL PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES tracked_products(product_id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL,        -- groups every attempt from the same trigger together
  attempt_number  INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('success', 'retried', 'failed')),
  http_status     INTEGER,              -- status code seen from the price API, if any
  message         TEXT,                 -- short human-readable detail, e.g. the error seen
  duration_ms     INTEGER,              -- how long this attempt took
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_product_time ON price_history (product_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_log_product_time ON scrape_log (product_id, started_at DESC);

-- Speeds up the age-based DELETE in POST /api/cron/cleanup-logs
-- (WHERE started_at < ...), which filters across ALL products, not just
-- one - the composite index above (product_id, started_at DESC) doesn't
-- help there since it's not filtering by product_id at all.
CREATE INDEX IF NOT EXISTS idx_scrape_log_started_at ON scrape_log (started_at);
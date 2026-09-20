
CREATE TABLE IF NOT EXISTS tracked_products (
  product_id    TEXT PRIMARY KEY,      
  product_name  TEXT NOT NULL,          
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS price_history (
  id            SERIAL PRIMARY KEY,
  product_id    TEXT NOT NULL REFERENCES tracked_products(product_id) ON DELETE CASCADE,
  price         NUMERIC NOT NULL,       -- the "Current price" shown on the page
  deal_price    NUMERIC,                -- the "Deal price" shown on the page, if any
  mrp           NUMERIC,                -- the "MRP" shown on the page, if any
  in_stock      INTEGER,                -- the "In stock" number shown on the page, if any
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS scrape_log (
  id              SERIAL PRIMARY KEY,
  product_id      TEXT NOT NULL REFERENCES tracked_products(product_id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL,        -- a UUID for the whole scrape run, shared by all attempts
  attempt_number  INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('success', 'retried', 'failed')),
  http_status     INTEGER,              --  the HTTP status code of the page load, if any (null if the page never loaded)
  message         TEXT,                 -- any error message or other info from the attempt
  duration_ms     INTEGER,              -- how long the attempt took, in milliseconds
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_product_time ON price_history (product_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_log_product_time ON scrape_log (product_id, started_at DESC);


CREATE INDEX IF NOT EXISTS idx_scrape_log_started_at ON scrape_log (started_at);
live link : https://inetracker-xi.vercel.app
github link: https://github.com/19-Ayush-Jindal/INE-PRICETRACKER
target website : demo.inelabteamdev.com


Search for a product on demo.inelabteamdev.com, pick it from a dropdown,
and the app scrapes and tracks its price/stock every 2 hours - with an
honest, per-attempt scrape log and a price history chart.


--Database (PostgreSQL Supabase)
Create a free Supabase project.
In the SQL editor, run backend/schema.sql.
From Project Settings -> Database -> Connection string, copy the URI
(Transaction pooler mode) - this is your PG_CONNECTION_STRING.



--Backend(deployed on render || language use : Node.js)
npm install
npx playwright install chromium
npm run build-index      # scans the store and writes product-index.json
npm start

environment variable :
{
PG_CONNECTION_STRING=postgresql://postgres:19@Ayush7206@db.czididurtjiavixgvwut.supabase.co:5432/postgres,
CRON_SECRET=hellothisishacker,
PORT=4000
SCRAPE_CONCURRENCY=3
}


--Frontend(deployed on vercel || Framework used : React)
npm install
npm run dev



--Scraping schedule
Every 2 hours, triggered externally (see above). Within one run, up to
SCRAPE_CONCURRENCY products (default 5) are scraped in parallel, each
launching its own headless Chromium instance; each product gets up to 4
attempts before being logged as failed (see backend/scraper.js for the
retry logic). All scrapes in the same run share one run_id, so every
attempt logged from a given 2-hourly run can be looked up together.
Scrape log rows older than 7 days are deleted daily by the cleanup job
above; price history itself is never deleted.



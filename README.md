# INE Store Price Tracker

Search for a product on `demo.inelabteamdev.com`, pick it from a dropdown,
and the app scrapes and tracks its price/stock every 2 hours - with an
honest, per-attempt scrape log and a price history chart.

## Project layout

```
backend/    Express API + the Playwright scraper + Postgres schema
frontend/   React (Vite) app: search box, dropdown, chart, scrape log
```

## How the pieces fit together

```
 React frontend (Vercel)
        |
        |  fetch()
        v
 Express backend (Render)  <-----  cron-job.org POSTs to
        |                          /api/cron/scrape-all every 2 hours
        |  reads/writes
        v
 Supabase (Postgres)
```

The frontend never scrapes anything itself - it only calls the backend's
API. The backend is the only thing that talks to `demo.inelabteamdev.com`,
and it only does so in two situations: when a user tracks a new product
(one immediate scrape, so they see data right away instead of waiting up to
2 hours), and when the external cron service triggers a scheduled batch
scrape of everything currently tracked.

## Why an external cron service instead of a timer inside the app

Render's free tier puts the backend to sleep after a period of no traffic.
A `setInterval` running inside that process would simply stop firing while
the process is asleep - there is no "always on" free tier to rely on.
Instead, `POST /api/cron/scrape-all` is a normal HTTP endpoint, and an
external service (cron-job.org) is what actually calls it every 2 hours.
That HTTP request is itself what wakes the backend up if it was asleep, so
the schedule keeps working without needing an always-on process.

## Setup

### 1. Database (Supabase)

1. Create a free Supabase project.
2. In the SQL editor, run `backend/schema.sql`.
3. From Project Settings -> Database -> Connection string, copy the URI
   (Transaction pooler mode) - this is your `PG_CONNECTION_STRING`.

### 2. Backend

```bash
cd backend
cp .env.example .env      # fill in PG_CONNECTION_STRING and CRON_SECRET
npm install
npx playwright install chromium
npm run build-index       # scans the store and writes product-index.json
npm start
```

The API listens on `http://localhost:4000` (or `$PORT`).

### 3. Frontend

```bash
cd frontend
cp .env.example .env.local   # set VITE_API_BASE_URL to your backend's URL
npm install
npm run dev
```

## Deployment

- **Backend -> Render**: create a Web Service from the `backend/` folder.
  Build command: `npm install && npx playwright install --with-deps chromium`.
  Start command: `npm start`. Set `PG_CONNECTION_STRING` and `CRON_SECRET`
  as environment variables in Render's dashboard. Commit `product-index.json`
  (generated locally via `npm run build-index`) so it deploys with the app.
- **Frontend -> Vercel**: import the `frontend/` folder as a Vite project.
  Set `VITE_API_BASE_URL` to your Render backend's public URL.
- **Scheduling -> cron-job.org**: create a job that sends a `POST` request
  every 2 hours to:
  `https://<your-render-app>.onrender.com/api/cron/scrape-all?secret=<CRON_SECRET>`

## Scraping schedule

Every 2 hours, triggered externally (see above). Each tracked product is
scraped one at a time within that run, with up to 4 attempts each before
being logged as failed (see `backend/scraper.js` for the retry logic).

## Running the scraper in headed mode (for the demo recording)

```bash
cd backend
npm run scrape-headed -- 3          # opens a real, visible browser window
npm run scrape-headed -- 3 --slow   # same, but slowed down for recording
```

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `PG_CONNECTION_STRING` | backend | Supabase Postgres connection string |
| `CRON_SECRET` | backend | Shared secret the cron service must send to trigger a scrape |
| `PORT` | backend | Local dev port (Render sets this automatically in production) |
| `VITE_API_BASE_URL` | frontend | URL of the deployed backend |

See `DESIGN_NOTE.md` for how the scraping reliability was actually built up
(including what broke on the first few attempts and why).

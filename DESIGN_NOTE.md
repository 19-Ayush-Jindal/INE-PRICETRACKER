# Design note: making the scraper reliable

## What the store actually does to resist scraping

Before writing any retry logic, I spent time just watching the site's
Network tab by hand. It's doing more than one thing to make scraping hard:

1. The price API (`GET /api/products/:id/price`) is gated behind a
   client-side proof-of-work challenge. `GET /api/challenge` returns a WASM
   blob plus a salt/difficulty; the page's own JS solves it and trades the
   answer at `/api/session` for a bearer token before the price call is
   allowed.
2. Even once authenticated, the price response body is an encrypted blob
   (`{ productId, v, e, serverTime }`) - there's no plaintext price on the
   wire anywhere. Only the page's own JS can turn `e` into a number.
3. The rendered price text has zero-width characters (`​` etc.) woven
   between the digits, to break naive copy/paste or text-scraping of the
   DOM.
4. The cookie-consent banner can reappear mid-session, not just once at
   page load.
5. The price API intentionally returns occasional `5xx` errors on top of
   ordinary slowness.

Given (1) and (2), I decided against reverse-engineering the WASM solver
and whatever decodes `e` - that would be fragile and would break the moment
either detail changed. Instead I drive a real (Playwright) browser and read
whatever price the page itself renders, the same way a human visitor would.
That's a real trade-off: it's slower per lookup (several seconds, sometimes
more with retries) than a plain HTTP request would be, and it costs more
memory/CPU per scrape. I accepted that cost because it doesn't depend on
private wire-format details that could change without notice.

## What the AI assistant got wrong on the first pass, and how it got fixed

**Assumed hovering alone reveals the price.** The first version hovered
over the price box and then just polled the DOM for a rendered price. That
matched what I'd seen watching the network tab by hand in one browser
session - but it turned out that specific session had gotten lucky. Testing
the actual generated script against the real site showed hovering only
*enables* the "Reveal price" button (the subtext changes from "Hover over
the price area..." to "Check the current price and availability") - it
does **not** fetch anything by itself. The fix was to explicitly wait for
the button to become enabled after hovering, then click it, and only then
start polling for the result.

**Missed the zero-width characters at first.** Early parsing logic matched
`₹` amounts directly against the raw DOM text and got inconsistent results
- amounts that looked identical printed to two different numbers depending
on how they were compared. Inspecting the raw string (not just the
console-rendered text) showed zero-width space characters
(`​`/`‌`/`‍`/`﻿`) inserted between individual digits.
The fix was a `cleanText()` step that strips those characters before any
parsing happens, and every price-reading path in the app routes through it.

**Treated the reveal as a one-shot action.** The first retry-free version
worked when the site behaved, but real runs showed the cookie banner
reappearing mid-flow (blocking the hover/click) and the price API
occasionally returning `5xx`. Both would silently produce "Price hidden"
forever with no error, which is exactly the "silently stop or store
incorrect data" failure mode the assignment explicitly calls out. The fix
was twofold: call the cookie-dismissal check at several points in the flow
instead of once at page load, and wrap the whole hover -> click -> poll
cycle in a retry loop (`scrapeProductWithRetries` in `backend/scraper.js`)
that watches the actual HTTP status of the price API call and gives up
early on a `5xx` rather than waiting out the full timeout.

**Started out logging only the final outcome.** The first design only
wrote one row per scheduled scrape (success or failure). The assignment
asks for a log of "every scrape attempt... success, retried, or failed" -
so `onAttempt()` was added as a callback into the retry loop itself, and
`scrape_log` now gets one row per *attempt*, not per run. A run that
succeeded on the third try shows two `retried` rows followed by one
`success` row, rather than a single row that hides how much trouble it
took to get there.

## Reliability decisions in the final version

- **Every attempt is logged, success or not** (`scrape_log`), and a
  `price_history` row is only ever written on an actual successful,
  fully-parsed reading - a failed attempt never produces a partial or
  guessed data point.
- **Retries with backoff** (`backend/scraper.js`, `scrapeProductWithRetries`):
  up to 4 attempts per scheduled scrape, each in a fresh browser context (so
  one attempt's broken state - e.g. an open cookie banner - can't carry
  into the next), with a small increasing delay between attempts.
- **Fail loud, not silent.** If every attempt fails, the route still
  responds/logs the failure explicitly rather than swallowing the error -
  nothing pretends a scrape succeeded when it didn't.
- **Scheduling is HTTP-triggered**, not an in-process timer, specifically
  because Render's free tier sleeps - see the README for why.

## What I'd improve with more time

- Change detection: hashing the page's structural selectors (`.price-block`,
  the reveal button's markup) and flagging in the scrape log when they
  change, so a future site redesign is caught rather than silently causing
  every scrape to fail the same way.
- Running multiple tracked products' scrapes concurrently (with a
  concurrency cap) rather than strictly one at a time, to keep a large
  tracked list finishing well within the 2-hour window.

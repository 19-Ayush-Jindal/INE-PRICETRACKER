# Design note: making the scraper reliable

## How I found the real problem before writing any code

I explored the target site myself first, in Chrome DevTools, before asking
an AI tool to write anything:

- Tried hitting a price endpoint directly (`GET /api/products/:id/price`)
  with no browser - rejected outright. No plaintext price over plain HTTP.
- Checked the product/catalog endpoint (`GET /api/products/:id`) - that one
  works with no auth, so only the *price* is protected.
- Opened a product page with Network tab recording and clicked "Reveal
  price" myself. It's two calls, not one: a **"challenge"** call
  (`GET /api/challenge`, hands back a proof-of-work puzzle) followed by a
  **"price"** call that only succeeds once the page's own JS solves that
  challenge and trades it for a session token. Even then the price comes
  back as an encrypted blob, not a plain number.

That finding is why I decided the scraper had to drive a real browser
(Playwright) end to end and read whatever the page itself renders, rather
than reverse-engineer the challenge solver or the encrypted response -
fragile, and would break the moment either detail changed.

## Mistakes I caught and corrected

**Hover alone doesn't fetch anything.** The first version polled the DOM
right after hovering. I tested it against the real site and found hovering
only enables the "Reveal price" button - you still have to click it. Fixed
by waiting for the button to enable, then clicking, then polling.

**Zero-width characters in the price text.** Amounts that looked identical
were parsing to different numbers. I inspected the raw string and found
zero-width characters woven between digits. Fixed with a `cleanText()` step
used everywhere a price is read.

**Reveal treated as one-shot.** Real runs showed the cookie banner
reappearing mid-flow and the price API returning occasional `5xx`s, both
silently producing "Price hidden" forever. I asked for retries with an
honest per-attempt log instead of hiding the failure.

**Untraceable batch runs.** Every scrape in a 2-hourly batch got its own
random id, so I couldn't look up "everything from the 5:30pm run" together.
I asked for one shared `run_id` per batch.

**A price that didn't match the real site.** I noticed a logged ₹4 on a
product that actually cost thousands - the price renders digit-by-digit and
the code accepted a half-finished animation frame. Fixed by requiring the
same reading twice in a row before trusting it.

**"Button doesn't exist" read as "button is disabled."** I recorded a
product failing all 5 attempts even though the price was clearly already
visible on screen. Some product pages load with the price already revealed
(no "Reveal price" button at all), and `.isDisabled().catch(() => true)`
treated "button not found" the same as "button disabled," burning every
retry hunting for a button that would never appear. I caught this from the
recording and asked why it failed "even though the reveal button was
handled" - fixed with an explicit already-revealed check.

**Frontend hid existing history behind a fresh scrape.** Selecting a
product blocked on a ~15s live scrape *before* loading its existing history
from the database, so a product with months of data sat on a blank screen
the whole time. I asked for history to load first, scrape to run after. The
first attempt at this fix still didn't work - I verified it properly by
testing on a product I already knew had history (not a brand-new one) and
recording the chart still rendering empty for several seconds before it
loaded, which is what proved the fix wasn't actually live yet (see below).

## A pitfall that wasn't a code bug: silent non-deployment

Every fix above was committed and pushed to GitHub, but none of it reached
the live Vercel site - it kept behaving like the first version. I tracked
it down myself by checking Vercel's Deployments tab (only one deployment,
ever) and then its Git settings: Vercel was connected to a different,
similarly-named repo (`inepricetracker`) than the one I was actually
pushing to (`INE-PRICETRACKER`). Pushes succeeded on GitHub every time;
they just never triggered a deploy. Worth flagging because it looks exactly
like a broken fix from the outside.

## Key decisions

- Every scrape *attempt* is logged (success, retried, or failed) - only a
  fully successful read ever writes a `price_history` row.
- Up to 4 attempts per scrape, each on the same loaded page rather than a
  fresh reload, since reloading re-rolled the cookie-banner timing race.
- Scheduling is HTTP-triggered (`POST /api/cron/scrape-all` from
  cron-job.org), not an in-process timer, because Render's free tier sleeps.
- All products are seeded into the tracked list at startup, not just ones a
  user searches for, so every product has history from day one.
- Batch scrapes run at a bounded concurrency (`SCRAPE_CONCURRENCY`), default
  5) - fast enough to finish 1,000 products inside the 2-hour window
  without running a free-tier instance out of memory.
// scraper.js
//
// Everything needed to reveal, read, and reliably re-try a single product's
// price/stock on https://demo.inelabteamdev.com.
//
// WHY A HEADLESS BROWSER AT ALL (and not a plain HTTP request):
// The price is not available as a plain HTTP response you can fetch and
// parse. Looking at the page's own network traffic:
//   - The price API is gated behind a client-side proof-of-work challenge
//     (GET /api/challenge hands back a WASM blob + a difficulty; the page's
//     own JS solves it and trades the answer at /api/session for a bearer
//     token before the price call is allowed).
//   - Even once authenticated, the price response body is an encrypted
//     blob ({ productId, v, e, serverTime }) - there is no plaintext price
//     anywhere on the wire, only the page's own JS can turn "e" into a
//     number.
// Reverse-engineering that WASM solver and whatever decodes "e" would be
// fragile and would break the moment the site changes either one. Instead
// this drives a real (headless, or headed for the demo recording) Chromium
// via Playwright and does exactly what a human visitor does.
//
// WHY IT'S NOT AS SIMPLE AS "LOAD PAGE, READ PRICE":
// The store deliberately makes this awkward in a few specific ways this
// file works around one at a time:
//   1. The price is hidden until you interact with it. Hovering the price
//      box only ENABLES the "Reveal price" button - it does not fetch
//      anything by itself. You then have to actually click the (now
//      enabled) button to trigger the real fetch. (We assumed hovering
//      alone was enough on the first pass and got stuck on "Price hidden"
//      forever - see the design note for the full story.)
//   2. The rendered price text has zero-width characters woven between the
//      digits (e.g. "1​8​,​8​2​0") to break naive
//      copy/paste or text scraping. We strip these back out.
//   3. The store randomly re-shows its cookie banner mid-flow, which can
//      sit on top of the price box and swallow the hover/click if you only
//      dismiss it once at page load.
//   4. The price API intentionally returns occasional 5xx errors, on top of
//      ordinary slowness. A single attempt is not reliable enough to trust
//      - this file retries the whole reveal cycle with backoff, and every
//      attempt (successful or not) is reported through onAttempt() so the
//      caller can log it honestly instead of only recording the final
//      outcome.

const { chromium } = require('playwright');

const BASE_URL = 'https://demo.inelabteamdev.com';

// Characters the site injects into the price text to defeat naive scraping.
const ZERO_WIDTH_CHARACTERS = /[​‌‍﻿⁠]/g;

function cleanText(rawText) {
  return (rawText || '').replace(ZERO_WIDTH_CHARACTERS, '').replace(/\s+/g, ' ').trim();
}

function extractRupeeAmounts(cleanedText) {
  const amounts = [];
  const pattern = /₹\s*([\d,]+(?:\.\d+)?)/g;
  let match;
  while ((match = pattern.exec(cleanedText))) {
    amounts.push(Number(match[1].replace(/,/g, '')));
  }
  return amounts;
}

/**
 * Turns the price block's raw (possibly zero-width-obfuscated) text into
 * structured numbers. Layout on the page, in order, is: struck-through MRP,
 * "Deal price", then the actual final price - see the product page markup.
 */
function parsePriceBlockText(rawText) {
  const text = cleanText(rawText);
  const amounts = extractRupeeAmounts(text);

  const mrp = amounts.length > 0 ? amounts[0] : null;
  const price = amounts.length > 0 ? amounts[amounts.length - 1] : null;
  const dealPrice = amounts.length > 2 ? amounts[1] : null;

  const stockMatch = text.match(/(\d+)\s*IN STOCK/i);
  const discountMatch = text.match(/(\d+)%\s*off/i);

  return {
    price,
    dealPrice,
    mrp,
    inStock: stockMatch ? Number(stockMatch[1]) : null,
    discountPercent: discountMatch ? Number(discountMatch[1]) : null,
    rawText: text,
  };
}

/**
 * Dismisses the cookie banner if it's currently showing. Safe to call
 * repeatedly and speculatively - it's a no-op when the banner isn't there.
 * The banner can reappear mid-flow on this site, so we call this at several
 * points rather than once at page load.
 */
async function dismissCookieBannerIfPresent(page) {
  const acceptButton = page.getByRole('button', { name: /accept/i });
  if (await acceptButton.count().catch(() => 0)) {
    await acceptButton.first().click({ timeout: 1500 }).catch(() => {});
  }
}

/**
 * Loads the product page ONCE. This is deliberately separate from the
 * hover/click/poll logic below: re-navigating (a full page reload) on
 * every single retry attempt turned out to make things LESS reliable, not
 * more - every fresh load re-rolls the dice on the cookie banner's
 * appear-late timing, so re-loading on every attempt meant hitting that
 * same race on every attempt instead of just occasionally. Retrying the
 * hover/click cycle on the SAME already-loaded page (as a real user
 * retrying a stuck click would) is both faster and more reliable.
 */
async function loadProductPage(page, productId, { timeoutMs = 15000 } = {}) {
  const url = `${BASE_URL}/product/${productId}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });

  // Give the cookie banner a brief moment to mount before we check for it -
  // on this site it isn't always present in the very first paint.
  await page.waitForTimeout(300);
  await dismissCookieBannerIfPresent(page);

  const productNameOnPage = await page.locator('h1').first().innerText().catch(() => null);
  if (!productNameOnPage) {
    throw new Error(`Product page for id ${productId} did not render a title - it may not exist.`);
  }
  return cleanText(productNameOnPage);
}

/**
 * A single, unretried attempt at revealing and reading the price, on a page
 * that has ALREADY been navigated to the right product (see
 * loadProductPage above). Throws (with a descriptive message) on anything
 * that goes wrong - the caller (scrapeProductWithRetries) decides what to
 * do about that, including whether to retry on this same page.
 */
async function attemptReveal(page, productId, { attemptTimeoutMs = 20000 } = {}) {
  await dismissCookieBannerIfPresent(page);

  const priceBlock = page.locator('.price-block');
  await priceBlock.waitFor({ state: 'visible', timeout: attemptTimeoutMs });

  // Track the price API's own response status for this attempt, so a
  // server-side failure (the intentional 5xxs) can be reported honestly
  // even if the page itself never visibly changes.
  let priceApiStatus = null;
  const onResponse = (response) => {
    if (response.url().includes(`/api/products/${productId}/price`)) {
      priceApiStatus = response.status();
    }
  };
  page.on('response', onResponse);

  try {
    // IMPORTANT: because retries now happen on the same already-loaded page
    // (see loadProductPage's comment), a previous attempt's click may
    // already have a challenge-solve + fetch in flight when this attempt
    // starts. Clicking again while that's still running would restart the
    // site's async work from zero every retry, which is exactly what
    // caused every attempt to time out the first time this was tried. So:
    // only hover + click when the box is genuinely idle (showing the
    // "Price hidden" / "Check the current price" placeholder) - if it's
    // already showing "Loading current price...", just keep waiting on it
    // instead of re-triggering it.
    const textBeforeThisAttempt = cleanText(await priceBlock.innerText());
    const alreadyInFlight = textBeforeThisAttempt.includes('Loading');

    if (!alreadyInFlight) {
      // Step 1: hover moves the mouse in gradually (not a teleport) so the
      // site's mouseenter handler actually fires. This only ENABLES the
      // button - it does not fetch the price by itself.
      const box = await priceBlock.boundingBox();
      if (!box) throw new Error('Price block has no visible bounding box.');
      await page.mouse.move(box.x - 50, box.y - 50);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
      await dismissCookieBannerIfPresent(page); // it can pop back up right here

      // Step 2: click the (now hopefully enabled) button - THIS is what
      // actually kicks off the challenge-solve + price fetch.
      const revealButton = page.getByRole('button', { name: /reveal price/i });

      // The site enables this button asynchronously, in its OWN mouseenter
      // handler - that handler doesn't run synchronously with the mouse
      // move events above, it runs on the next tick(s) after them. Checking
      // isDisabled() the instant the hover finishes was racing that and
      // losing most of the time: real-world runs showed attempts 1-3
      // consistently failing this check in ~250-300ms (far too fast to be
      // the site actually being slow) and only succeeding on attempt 4,
      // which burned 3 of every 4 retry attempts on nothing and turned what
      // should have been occasional real failures into products failing
      // outright after 4 attempts. Give the button up to 2 seconds to
      // actually flip to enabled before concluding it's genuinely stuck.
      const enableDeadline = Date.now() + 2000;
      let isDisabled = await revealButton.isDisabled().catch(() => true);
      while (isDisabled && Date.now() < enableDeadline) {
        await page.waitForTimeout(150);
        isDisabled = await revealButton.isDisabled().catch(() => true);
      }
      if (isDisabled) {
        throw new Error('Reveal button is still disabled after hovering - mouseenter likely did not register.');
      }
      await dismissCookieBannerIfPresent(page);
      await revealButton.click({ timeout: 5000 });
    }

    // Step 3: poll the DOM until the real price text renders, bailing out
    // early if we see the price API return a server error - no point
    // waiting out the full timeout when the server has already told us
    // it failed.
    const deadline = Date.now() + attemptTimeoutMs;
    let text = await priceBlock.innerText();
    while (Date.now() < deadline) {
      const cleaned = cleanText(text);
      if (cleaned.includes('₹') && !cleaned.includes('Loading') && !cleaned.includes('Price hidden')) {
        return { ...parsePriceBlockText(text), httpStatus: priceApiStatus };
      }
      if (priceApiStatus && priceApiStatus >= 500) {
        throw new Error(`Price API returned HTTP ${priceApiStatus}`);
      }
      await page.waitForTimeout(200);
      text = await priceBlock.innerText();
    }

    throw new Error(
      priceApiStatus ? `Timed out waiting for price (last API status ${priceApiStatus})` : 'Timed out waiting for price'
    );
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * The function everything else in the app calls. Retries attemptReveal()
 * with a short backoff, reporting EVERY attempt (not just the final one)
 * through onAttempt so the caller can write an honest scrape_log - "success
 * on attempt 3" should look different in the log than "succeeded first
 * try", and a total failure should say so plainly rather than being
 * silently dropped.
 *
 * @param {import('playwright').Browser} browser
 * @param {string} productId
 * @param {object} options
 * @param {number} [options.maxAttempts]
 * @param {(attempt: {attemptNumber:number, status:'success'|'retried'|'failed', httpStatus:number|null, message:string, durationMs:number}) => void} [options.onAttempt]
 */
async function scrapeProductWithRetries(browser, productId, { maxAttempts = 4, onAttempt = () => {} } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });

  try {
    const page = await context.newPage();

    // Navigating is its own thing, tried once here - a product that
    // genuinely doesn't exist, or a page that fails to load at all, isn't
    // something re-hovering/re-clicking would ever fix. If this throws, it
    // propagates straight up as a hard failure (still surfaced to the
    // caller, never silently swallowed).
    const productName = await loadProductPage(page, productId);

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
      const startedAt = Date.now();

      try {
        const result = await attemptReveal(page, productId);
        onAttempt({
          attemptNumber,
          status: 'success',
          httpStatus: result.httpStatus,
          message: `Revealed price ₹${result.price}`,
          durationMs: Date.now() - startedAt,
        });
        return { productName, ...result }; // done - stop retrying
      } catch (err) {
        const isLastAttempt = attemptNumber === maxAttempts;
        onAttempt({
          attemptNumber,
          status: isLastAttempt ? 'failed' : 'retried',
          httpStatus: null,
          message: err.message,
          durationMs: Date.now() - startedAt,
        });
        if (isLastAttempt) {
          throw new Error(`Gave up on product ${productId} after ${maxAttempts} attempts: ${err.message}`);
        }
        // Small increasing backoff before the next attempt on the SAME
        // page - gives a transient server error, or a mid-flow cookie
        // banner, a moment to clear instead of hammering it.
        await page.waitForTimeout(500 * attemptNumber);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = {
  scrapeProductWithRetries,
  parsePriceBlockText,
  cleanText,
  dismissCookieBannerIfPresent,
};
const { chromium } = require('playwright');

const BASE_URL = 'https://demo.inelabteamdev.com';
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

async function dismissCookieBannerIfPresent(page) {
  const acceptButton = page.getByRole('button', { name: /accept/i });
  if (await acceptButton.count().catch(() => 0)) {
    await acceptButton.first().click({ timeout: 1500 }).catch(() => {});
  }
}


async function loadProductPage(page, productId, { timeoutMs = 15000 } = {}) {
  const url = `${BASE_URL}/product/${productId}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
  await page.waitForTimeout(300);
  await dismissCookieBannerIfPresent(page);

  const productNameOnPage = await page.locator('h1').first().innerText().catch(() => null);
  if (!productNameOnPage) {
    throw new Error(`Product page for id ${productId} did not render a title - it may not exist.`);
  }
  return cleanText(productNameOnPage);
}

async function attemptReveal(page, productId, { attemptTimeoutMs = 50000 } = {}) {
  await dismissCookieBannerIfPresent(page);

  const priceBlock = page.locator('.price-block');
  await priceBlock.waitFor({ state: 'visible', timeout: attemptTimeoutMs });


  let priceApiStatus = null;
  const onResponse = (response) => {
    if (response.url().includes(`/api/products/${productId}/price`)) {
      priceApiStatus = response.status();
    }
  };
  page.on('response', onResponse);

  try {

    const textBeforeThisAttempt = cleanText(await priceBlock.innerText());
    const alreadyInFlight = textBeforeThisAttempt.includes('Loading');

    // Some product pages load with the price ALREADY revealed (a "Refresh
    // price" button instead of "Reveal price") rather than hidden behind a
    // click - a second UI state this site serves on some loads. Trying to
    // hover/click a "Reveal price" button that doesn't exist on THIS page
    // was throwing, getting swallowed by the isDisabled() catch, and
    // getting misread as "button still disabled" for the full 2-second
    // poll, every attempt, until all retries were burned on nothing even
    // though the real price was already sitting on the page the whole
    // time. If the price is already showing, skip the reveal step
    // entirely and let the polling below (step 3) just read it.
    const alreadyRevealed =
      textBeforeThisAttempt.includes('₹') &&
      !textBeforeThisAttempt.includes('Loading') &&
      !textBeforeThisAttempt.includes('Price hidden');

    if (!alreadyInFlight && !alreadyRevealed) {

      const box = await priceBlock.boundingBox();
      if (!box) throw new Error('Price block has no visible bounding box.');
      await page.mouse.move(box.x - 50, box.y - 50);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 });
      await dismissCookieBannerIfPresent(page); 

      const revealButton = page.getByRole('button', { name: /reveal price/i });

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

    const deadline = Date.now() + attemptTimeoutMs;
    let text = await priceBlock.innerText();
    while (Date.now() < deadline) {
      const cleaned = cleanText(text);
      const looksComplete = cleaned.includes('₹') && !cleaned.includes('Loading') && !cleaned.includes('Price hidden');

      if (looksComplete) {
        // The price can render in via a digit-by-digit reveal animation, so
        // text that already has a "₹" and no "Loading"/"Price hidden"
        // placeholder isn't necessarily the FINAL number yet - it could be
        // a partial in-progress frame (e.g. "₹4" on its way to becoming
        // "₹4,026"). A real mismatch we saw (a notebook briefly recorded at
        // ₹4) matches this exactly. Wait a beat and re-read; only trust the
        // text once it's identical two reads in a row.
        await page.waitForTimeout(300);
        const confirmText = await priceBlock.innerText();
        if (cleanText(confirmText) === cleaned) {
          return { ...parsePriceBlockText(confirmText), httpStatus: priceApiStatus };
        }
        text = confirmText;
        continue;
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
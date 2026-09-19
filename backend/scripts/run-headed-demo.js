// scripts/run-headed-demo.js
//
// Runs the scraper in HEADED mode (a real, visible browser window) against
// one product, so its behavior can actually be watched - this is what the
// screen recording deliverable is made from. It deliberately prints every
// attempt (including retried/failed ones) to the console as they happen,
// so a slow or failing response is visible both on screen and in the log.
//
// Usage:
//   node scripts/run-headed-demo.js 3
//   node scripts/run-headed-demo.js 3 --slow      (adds a slowMo delay so
//                                                    the mouse movement /
//                                                    clicks are easy to see
//                                                    on camera)

const { chromium } = require('playwright');
const { scrapeProductWithRetries } = require('../scraper');

async function main() {
  const productId = process.argv[2] || '3';
  const slow = process.argv.includes('--slow');

  console.log(`Launching a HEADED browser to scrape product ${productId}...`);
  const browser = await chromium.launch({
    headless: false,
    slowMo: slow ? 250 : 0, // milliseconds of artificial delay between actions, for the recording
  });

  try {
    const result = await scrapeProductWithRetries(browser, productId, {
      maxAttempts: 5,
      onAttempt: (attempt) => {
        const label = attempt.status.toUpperCase();
        console.log(
          `[attempt ${attempt.attemptNumber}] ${label} (${attempt.durationMs}ms) - ${attempt.message}` +
            (attempt.httpStatus ? ` [HTTP ${attempt.httpStatus}]` : '')
        );
      },
    });

    console.log('\nFINAL RESULT:');
    console.log(result);
  } catch (err) {
    console.error('\nScrape ultimately failed:', err.message);
  } finally {
    // Leave the window open for a couple of seconds at the end so the
    // recording clearly shows the final state before it closes.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await browser.close();
  }
}

main();

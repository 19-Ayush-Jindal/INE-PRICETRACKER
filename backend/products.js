// products.js
//
// A small local index mapping product NAME -> product ID on
// demo.inelabteamdev.com. The store itself doesn't expose a "search
// products" API, so instead of scraping it live on every keystroke, we keep
// a local list and search that.
//
// You don't have to type this list out by hand: run
//   npm run build-index
// (see scripts/build-product-index.js) to have it visit /product/1, /2, /3,
// ... on the store and generate product-index.json automatically. This file
// falls back to a couple of hand-entered examples so the app still works
// before you've run that script.

const fs = require('fs');
const path = require('path');

const GENERATED_INDEX_PATH = path.join(__dirname, 'product-index.json');

// Fallback list, used only if product-index.json hasn't been generated yet.
const FALLBACK_PRODUCTS = [
  { id: '3', name: 'Larkspur Speaker Pro', category: 'Audio' },
];

function loadProducts() {
  if (fs.existsSync(GENERATED_INDEX_PATH)) {
    try {
      const raw = fs.readFileSync(GENERATED_INDEX_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (err) {
      console.warn('Could not read product-index.json, falling back to defaults:', err.message);
    }
  }
  return FALLBACK_PRODUCTS;
}

// Loaded once at server start. Restart the server after regenerating
// product-index.json to pick up changes.
const PRODUCTS = loadProducts();

/**
 * Case-insensitive partial-name search, e.g. "spea" matches "Larkspur
 * Speaker Pro". Returns at most `limit` matches.
 */
function searchProducts(query, limit = 10) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return PRODUCTS.slice(0, limit);

  return PRODUCTS.filter((p) => p.name.toLowerCase().includes(q)).slice(0, limit);
}

function findProductById(id) {
  return PRODUCTS.find((p) => String(p.id) === String(id)) || null;
}

module.exports = { PRODUCTS, searchProducts, findProductById };



const fs = require('fs');
const path = require('path');

const GENERATED_INDEX_PATH = path.join(__dirname, 'product-index.json');

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

const PRODUCTS = loadProducts();

function searchProducts(query, limit = 10) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return PRODUCTS.slice(0, limit);

  return PRODUCTS.filter((p) => p.name.toLowerCase().includes(q)).slice(0, limit);
}

function findProductById(id) {
  return PRODUCTS.find((p) => String(p.id) === String(id)) || null;
}

module.exports = { PRODUCTS, searchProducts, findProductById };

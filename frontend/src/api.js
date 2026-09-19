// api.js
//
// Every fetch call to our own backend lives here in one place, so the
// components don't need to know URLs or response shapes directly.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

async function getJSON(path) {
  const res = await fetch(`${API_BASE_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed with ${res.status}`);
  return res.json();
}

async function postJSON(path, body) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `POST ${path} failed with ${res.status}`);
  return data;
}

// Search the store's product index by (partial) name -> used by the
// dropdown as the user types.
export function searchProducts(query) {
  return getJSON(`/api/products/search?q=${encodeURIComponent(query)}`);
}

// Start tracking a product (adds it to the DB and runs a first scrape).
export function trackProduct(productId) {
  return postJSON('/api/tracked', { productId });
}

// The price/stock history for a tracked product, used to draw the chart.
export function getProductHistory(productId) {
  return getJSON(`/api/products/${productId}/history`);
}

// Every scrape attempt for a tracked product, used for the scrape log table.
export function getProductLogs(productId) {
  return getJSON(`/api/products/${productId}/logs`);
}

// Manually trigger one scrape right now, instead of waiting for the
// 2-hourly schedule - handy while testing.
export function scrapeNow(productId) {
  return postJSON(`/api/products/${productId}/scrape-now`);
}

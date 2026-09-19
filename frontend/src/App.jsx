import { useEffect, useState, useCallback } from 'react';
import ProductSearch from './components/ProductSearch';
import PriceHistoryChart from './components/PriceHistoryChart';
import ScrapeLog from './components/ScrapeLog';
import { trackProduct, getProductHistory, getProductLogs, scrapeNow } from './api';

export default function App() {
  // The product currently selected from the dropdown / being viewed.
  const [selectedProduct, setSelectedProduct] = useState(null);

  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  const loadHistoryAndLogs = useCallback(async (productId) => {
    const [historyRes, logsRes] = await Promise.all([getProductHistory(productId), getProductLogs(productId)]);
    setHistory(historyRes.history);
    setLogs(logsRes.logs);
  }, []);

  // When a product is picked from the search dropdown: start tracking it
  // (which also runs an immediate first scrape on the backend), then load
  // whatever history/log data exists for it.
  async function handleSelectProduct(product) {
    setSelectedProduct(product);
    setIsLoading(true);
    setStatusMessage(`Tracking "${product.name}" and running a first scrape - this can take up to ~15 seconds...`);

    try {
      const { firstScrapeError } = await trackProduct(product.id);
      setStatusMessage(
        firstScrapeError
          ? `Tracking started, but the first scrape failed (${firstScrapeError}). It'll retry on the next scheduled run.`
          : ''
      );
      await loadHistoryAndLogs(product.id);
    } catch (err) {
      setStatusMessage(`Something went wrong: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleScrapeNow() {
    if (!selectedProduct) return;
    setIsLoading(true);
    setStatusMessage('Scraping now...');
    try {
      await scrapeNow(selectedProduct.id);
      await loadHistoryAndLogs(selectedProduct.id);
      setStatusMessage('');
    } catch (err) {
      setStatusMessage(`Scrape failed: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  // Re-fetch history/logs occasionally while a product is selected, so the
  // page reflects the 2-hourly scheduled scrapes without needing a manual
  // refresh.
  useEffect(() => {
    if (!selectedProduct) return;
    const interval = setInterval(() => loadHistoryAndLogs(selectedProduct.id), 60000);
    return () => clearInterval(interval);
  }, [selectedProduct, loadHistoryAndLogs]);

  return (
    <div className="app">
      <h1>INE Store Price Tracker</h1>

      <ProductSearch onSelect={handleSelectProduct} />

      {selectedProduct && (
        <section className="product-detail">
          <div className="product-detail-header">
            <h2>{selectedProduct.name}</h2>
            <button onClick={handleScrapeNow} disabled={isLoading}>
              {isLoading ? 'Working...' : 'Scrape now'}
            </button>
          </div>

          {statusMessage && <p className="status-message">{statusMessage}</p>}

          <h3>Price history</h3>
          <PriceHistoryChart history={history} />

          <h3>Scrape log</h3>
          <ScrapeLog logs={logs} />
        </section>
      )}
    </div>
  );
}

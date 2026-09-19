// A small hand-rolled line chart (plain SVG, no charting library). The
// assignment only asks for "a chart or table", and a tiny inline SVG is
// easier to fully understand and explain than pulling in a charting
// library for one line - every coordinate below is something you can trace
// by hand.

const WIDTH = 640;
const HEIGHT = 220;
const PADDING = 32;

export default function PriceHistoryChart({ history }) {
  if (!history || history.length === 0) {
    return <p className="empty-state">No price history yet - track a product to start collecting data.</p>;
  }

  const prices = history.map((point) => Number(point.price));
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  // Avoid a division by zero when every reading so far is the same price.
  const priceRange = maxPrice - minPrice || 1;

  const plotWidth = WIDTH - PADDING * 2;
  const plotHeight = HEIGHT - PADDING * 2;

  function xFor(index) {
    if (history.length === 1) return PADDING + plotWidth / 2;
    return PADDING + (index / (history.length - 1)) * plotWidth;
  }

  function yFor(price) {
    const ratio = (price - minPrice) / priceRange;
    return PADDING + plotHeight - ratio * plotHeight; // higher price = higher up
  }

  const linePoints = history.map((point, i) => `${xFor(i)},${yFor(Number(point.price))}`).join(' ');

  return (
    <div className="chart-wrapper">
      <svg width={WIDTH} height={HEIGHT} role="img" aria-label="Price history line chart">
        {/* Baseline + top guide lines, purely visual */}
        <line x1={PADDING} y1={HEIGHT - PADDING} x2={WIDTH - PADDING} y2={HEIGHT - PADDING} stroke="#ccc" />
        <line x1={PADDING} y1={PADDING} x2={WIDTH - PADDING} y2={PADDING} stroke="#eee" />

        {/* The price line itself */}
        <polyline points={linePoints} fill="none" stroke="#2563eb" strokeWidth="2" />

        {/* One dot per data point, with the exact price on hover */}
        {history.map((point, i) => (
          <circle key={i} cx={xFor(i)} cy={yFor(Number(point.price))} r="3.5" fill="#2563eb">
            <title>
              {new Date(point.fetched_at).toLocaleString()}: ₹{Number(point.price).toLocaleString('en-IN')}
            </title>
          </circle>
        ))}

        {/* Min/max price labels on the y-axis */}
        <text x={4} y={PADDING + 4} fontSize="11" fill="#666">
          ₹{maxPrice.toLocaleString('en-IN')}
        </text>
        <text x={4} y={HEIGHT - PADDING + 4} fontSize="11" fill="#666">
          ₹{minPrice.toLocaleString('en-IN')}
        </text>
      </svg>

      <div className="chart-caption">
        {history.length} reading{history.length === 1 ? '' : 's'} - latest:{' '}
        <strong>₹{Number(history[history.length - 1].price).toLocaleString('en-IN')}</strong> on{' '}
        {new Date(history[history.length - 1].fetched_at).toLocaleString()}
      </div>
    </div>
  );
}

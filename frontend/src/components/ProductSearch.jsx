import { useEffect, useRef, useState } from 'react';
import { searchProducts } from '../api';

// The two functionalities the app actually needs, per the assignment:
//   1. Search a product by (partial or full) name
//   2. Pick one of the matches from a dropdown
//
// This component only handles that - it calls onSelect(product) once the
// user picks something, and the parent (App.jsx) decides what to do next
// (start tracking it, show its history, etc).
export default function ProductSearch({ onSelect }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  // Set only when the search request itself fails (backend unreachable,
  // wrong API URL, etc.) - distinct from "zero results", which is a normal,
  // successful search that just didn't match anything.
  const [searchError, setSearchError] = useState(null);
  const debounceTimer = useRef(null);

  useEffect(() => {
    // Debounce so we're not firing a request on every single keystroke -
    // wait 250ms after the user stops typing before searching.
    clearTimeout(debounceTimer.current);

    if (!query.trim()) {
      setResults([]);
      setIsOpen(false);
      setSearchError(null);
      return;
    }

    debounceTimer.current = setTimeout(async () => {
      try {
        const { results } = await searchProducts(query);
        setResults(results);
        setSearchError(null);
        setIsOpen(true);
      } catch (err) {
        // Previously this only logged to the console and left the dropdown
        // closed - which looks EXACTLY like "no matches" or "nothing
        // happened" from the user's side, with no way to tell a real
        // connection problem apart from just having typed a bad query. Now
        // we surface it in the dropdown itself instead of hiding it.
        console.error('Product search failed:', err);
        setResults([]);
        setSearchError(err.message);
        setIsOpen(true);
      }
    }, 250);

    return () => clearTimeout(debounceTimer.current);
  }, [query]);

  function handleSelect(product) {
    setQuery(product.name);
    setIsOpen(false);
    onSelect(product);
  }

  return (
    <div className="product-search">
      <label htmlFor="product-search-input">Search for a product</label>
      <input
        id="product-search-input"
        type="text"
        value={query}
        placeholder="e.g. speaker"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setIsOpen(true)}
        autoComplete="off"
      />

      {isOpen && (
        <ul className="dropdown">
          {searchError && (
            <li className="dropdown-empty dropdown-error">
              Could not reach the server ({searchError}). Is the backend running?
            </li>
          )}
          {!searchError && results.length === 0 && <li className="dropdown-empty">No matching products</li>}
          {results.map((product) => (
            <li key={product.id} onClick={() => handleSelect(product)}>
              <span className="product-name">{product.name}</span>
              {product.category && <span className="product-category">{product.category}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

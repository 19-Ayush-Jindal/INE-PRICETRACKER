import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standard Vite + React setup, no extra configuration needed for Vercel -
// Vercel auto-detects a Vite project and runs `npm run build`.
export default defineConfig({
  plugins: [react()],
});

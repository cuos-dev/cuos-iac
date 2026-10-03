import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Dev: proxy API + WebSocket to the backend (app.js, default :3000) and inject the
// dev credentials so the browser doesn't prompt. Override with DEV_BACKEND / DEV_AUTH.
const target = process.env.DEV_BACKEND || 'http://127.0.0.1:3000';
const authorization = 'Basic ' + Buffer.from(process.env.DEV_AUTH || 'admin:admin').toString('base64');

export default defineConfig({
  plugins: [preact()],
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api': { target, headers: { authorization } },
      '/ws':  { target, ws: true, headers: { authorization } },
    },
  },
});

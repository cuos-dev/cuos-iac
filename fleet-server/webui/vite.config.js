import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Dev: proxy API + UI WebSocket to the fleet-server (default :8085) and inject the credentials
// so the browser doesn't prompt. Override with DEV_BACKEND / DEV_AUTH (e.g. DEV_AUTH=viewer:viewer for the read-only user). Open /ui/.
const target = process.env.DEV_BACKEND || 'http://127.0.0.1:8085';
const authorization = 'Basic ' + Buffer.from(process.env.DEV_AUTH || 'admin:admin').toString('base64');

export default defineConfig({
  plugins: [preact()],
  base: '/ui/',
  build: { outDir: 'dist' },
  server: {
    proxy: {
      '/api':   { target, headers: { authorization } },
      '/ui-ws': { target, ws: true, headers: { authorization } },
    },
  },
});

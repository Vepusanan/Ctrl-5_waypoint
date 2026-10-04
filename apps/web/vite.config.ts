import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// API_PROXY_TARGET points the dev server at an API on another port (default :3000).
const apiProxy = { '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3000' };

export default defineConfig({
  plugins: [
    react(),
    // SYSTEM_DESIGN §8.1: the service worker precaches the app shell only, so the app reloads with
    // no signal. API responses are never cached here; Dexie is the only offline data source.
    // New versions wait for the user (src/lib/pwa.tsx registers and prompts). The driver and
    // loader manifests are static files in public/, linked per workspace.
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    conditions: ['@waypoint/source', ...defaultClientConditions],
  },
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: { port: 4173, strictPort: true, proxy: apiProxy },
});

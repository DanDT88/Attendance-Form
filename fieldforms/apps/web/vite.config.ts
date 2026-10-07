import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const API_TARGET = process.env.API_URL ?? 'http://localhost:3000';
const proxy = { '/api': { target: API_TARGET, changeOrigin: false } };

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Our own service worker (src/sw.ts) so it can run the outbox sync on Background Sync events.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      // A classic (non-module) worker: module service workers need iOS 16.4+.
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,wasm}'],
        rollupFormat: 'iife',
      },
      devOptions: { enabled: false },
      manifest: {
        name: 'FieldForms',
        short_name: 'FieldForms',
        description: 'Attendance registers and field forms',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f4f6fa',
        theme_color: '#1b365d',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Libraries change far less often than the app, so they get their own long-cached
        // chunks: an app update then re-downloads only the small app chunk on prepaid data.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // The barcode reader loads only when someone scans; keep it out of the startup chunks.
          if (id.includes('zxing-wasm')) return undefined;
          if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id))
            return 'vendor-react';
          return 'vendor';
        },
      },
    },
  },
});

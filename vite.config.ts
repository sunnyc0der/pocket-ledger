import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: [],
    manifest: {
      name: 'Pocket Ledger', short_name: 'Ledger', description: 'Private personal finance tracker',
      theme_color: '#0f766e', background_color: '#f5f7f7', display: 'standalone',
      start_url: '/', icons: [
        { src: '/pwa-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
        { src: '/pwa-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }
      ]
    }, workbox: { navigateFallback: '/index.html' }
  })]
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Remote CLI Agents',
        short_name: 'RCA',
        description: 'Web-based remote control for CLI coding agents',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'any',
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: true,
    port: 9471,
    proxy: {
      '/api': 'http://127.0.0.1:9470',
      '/ws': {
        target: 'ws://127.0.0.1:9470',
        ws: true,
      },
      '/relay': {
        target: 'ws://127.0.0.1:9470',
        ws: true,
      },
    },
  },
});

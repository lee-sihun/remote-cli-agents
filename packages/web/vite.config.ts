import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const DEFAULT_WEB_PORT = 9471;
const DEFAULT_SERVER_PORT = 9470;

function resolvePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toWsTarget(target: string): string {
  const url = new URL(target);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export default defineConfig(() => {
  const webPort = resolvePort(process.env.RCA_WEB_PORT, DEFAULT_WEB_PORT);
  const serverPort = resolvePort(process.env.RCA_SERVER_PORT, DEFAULT_SERVER_PORT);
  const serverTarget = process.env.RCA_SERVER_URL || `http://127.0.0.1:${serverPort}`;
  const wsTarget = toWsTarget(serverTarget);

  return {
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
      port: webPort,
      proxy: {
        '/api': serverTarget,
        '/ws': {
          target: wsTarget,
          ws: true,
        },
        '/relay': {
          target: wsTarget,
          ws: true,
        },
      },
    },
  };
});

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import { THEME_BOOTSTRAP_SCRIPT } from '../../packages/ui/src/theme-bootstrap.ts';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

function apiProxy() {
  const target = process.env.MDR_API_PROXY;
  return target ? { proxy: { '/api': { target, changeOrigin: false } } } : {};
}

/** Serves/emits /theme-bootstrap.js from the single source in @mdr/ui. */
function themeBootstrap(): Plugin {
  return {
    name: 'mdr-theme-bootstrap',
    configureServer(server) {
      server.middlewares.use('/theme-bootstrap.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(THEME_BOOTSTRAP_SCRIPT);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'theme-bootstrap.js', source: THEME_BOOTSTRAP_SCRIPT });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), themeBootstrap()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  // Optional: MDR_API_PROXY=http://127.0.0.1:8080 forwards /api to a local server in dev/preview,
  // so sync can be tried without rebuilding the server image.
  server: { port: 5173, strictPort: true, ...apiProxy() },
  preview: apiProxy(),
});

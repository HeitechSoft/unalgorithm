import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the sign-in page into `dist`, which the server serves on its own origin (`WEB_DIST`). For `pnpm dev`, run the
 * server with `PUBLIC_URL=http://localhost:5173`: Vite forwards the server's routes to it (`UA_SERVER`, default
 * `http://127.0.0.1:8787`), so the page, its cookie and Better Auth's origin check all see one origin.
 */
const server = process.env.UA_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom', 'zod'] },
  build: { outDir: 'dist' },
  server: {
    proxy: Object.fromEntries(
      ['/api/auth', '/v1', '/.well-known', '/outlets.json', '/outlets/changes.json'].map((path) => [path, server]),
    ),
  },
});

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * `pnpm gallery`: every page of the portal in each of its states, against the test suite's fake server
 * (`test/support/fake-server.ts`), so a design change can be seen and screenshot without a server or a database. Never
 * built or served by the server.
 */
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'gallery-pages',
      // Every page address (no file extension) is the gallery page, which renders the scenario chosen last.
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const path = (req.url ?? '/').split(/[?#]/)[0] ?? '/';
          if (!path.startsWith('/@') && !path.startsWith('/node_modules') && !/\.[a-z0-9]+$/i.test(path)) {
            req.url = '/gallery.html';
          }
          next();
        });
      },
    },
  ],
  resolve: {
    dedupe: ['react', 'react-dom', 'zod'],
    alias: { vitest: fileURLToPath(new URL('./gallery/vitest-shim.ts', import.meta.url)) },
  },
  server: { port: 5180, strictPort: true, open: '/gallery.html' },
});

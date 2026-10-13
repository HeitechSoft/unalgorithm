import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/extension', 'apps/server', 'apps/web'],
  },
});

import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineProject({
  plugins: [WxtVitest({ root: fileURLToPath(new URL('.', import.meta.url)) })],
  test: {
    name: 'extension',
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
  },
});

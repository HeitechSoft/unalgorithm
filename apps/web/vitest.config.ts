import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'web', environment: 'jsdom', setupFiles: ['test/support/setup.ts'] },
});

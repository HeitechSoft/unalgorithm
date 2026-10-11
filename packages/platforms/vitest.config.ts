import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'platforms', environment: 'jsdom', setupFiles: ['test/setup.ts'] },
});

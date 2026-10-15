import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'sync', environment: 'node' },
});

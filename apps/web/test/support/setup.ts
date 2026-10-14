/**
 * Setup for every test of the web app (`setupFiles` in vitest.config.ts).
 *
 * Testing Library's `findBy*` queries and `waitFor` give up after 1 s by default. On a loaded Windows machine (two full
 * suites at once) the first query of a test file alone has taken just over 1 s, so this project waits up to 3 s, the
 * same for every test rather than per call. A wait that succeeds still returns as soon as it does: only a failing one
 * takes longer to fail, and within the 5 s a test may take.
 */
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 3_000 });

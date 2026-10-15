/**
 * Timeouts for the server's slow tests, sized for a loaded Windows machine: with two full suites running at once, a test
 * that starts a database or a process takes several times as long as it does alone. A test that reaches one of these is
 * stuck, not slow, so they only bound how long a stuck test holds its file. Nothing here waits for a fixed time.
 */

/**
 * A test that starts PGlite (Postgres compiled to WebAssembly) and migrates it, once or a few times, or a Postgres
 * database in CI: up to 15 s alone and over 30 s with two suites at once.
 */
export const PGLITE_TIMEOUT = 60_000;

/**
 * A test that starts Node.js or git, a few times or a dozen: each start takes under a second alone, and the test up to
 * 60 s with two suites at once.
 */
export const SPAWN_TIMEOUT = 120_000;

/**
 * One started process, killed after this so that a stuck one fails its test. `spawnSync` blocks the test file until the
 * process ends, so the test's own timeout cannot stop it.
 */
export const PROCESS_TIMEOUT = 60_000;

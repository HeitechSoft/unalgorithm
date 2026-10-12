import { ConfigError, loadConfig } from '../config.ts';

/**
 * Checks the environment the way the server will read it, without starting anything: `pnpm check-config`, or
 * `node apps/server/src/cli/check-config.ts` in the image. Prints variable names and rules, never values.
 */
try {
  const config = loadConfig(process.env);
  console.log(`config ok (server ${config.version})`);
} catch (err) {
  // A ConfigError's message names variables only; anything else is a bug, reported by name without its message.
  console.error(err instanceof ConfigError ? err.message : `check-config failed: ${err instanceof Error ? err.name : 'error'}`);
  process.exitCode = 1;
}

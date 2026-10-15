import { configuredRoutes, RouteConfigError } from '../ai/routes.ts';
import { ConfigError, loadConfig } from '../config.ts';

/**
 * Checks the environment the way the server will read it, without starting anything: `pnpm check-config`, or
 * `node apps/server/src/cli/check-config.ts` in the image. Runs the routing rules the server applies at startup too, so
 * an AI provider it would refuse fails here, before a deploy. Prints variable names and rules, never values.
 */
try {
  const config = loadConfig(process.env);
  configuredRoutes(config);
  console.log(`config ok (server ${config.version})`);
} catch (err) {
  // ConfigError and RouteConfigError messages name variables and rules only; anything else is a bug, reported by name
  // without its message.
  const named = err instanceof ConfigError || err instanceof RouteConfigError;
  console.error(named ? err.message : `check-config failed: ${err instanceof Error ? err.name : 'error'}`);
  process.exitCode = 1;
}

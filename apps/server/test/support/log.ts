import { createLogger, type LogLevel } from '../../src/log.ts';

/**
 * A logger whose lines land in `lines` instead of standard output; `events()` parses them. The default level is debug,
 * so nothing is filtered out. Server tests that assert on log lines use this rather than a sink of their own.
 */
export function captureLog(level: LogLevel = 'debug') {
  const lines: string[] = [];
  const log = createLogger({ level, sink: (line) => lines.push(line) });
  const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, lines, events };
}

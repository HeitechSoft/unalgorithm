import { createLogger, type LogLevel } from '../../src/log.ts';
import { createErrorWindow } from '../../src/ops/error-window.ts';

/**
 * A logger whose lines land in `lines` instead of standard output; `events()` parses them, and `errors` counts its error
 * lines as the server's logger feeds its window (CL4-14). The default level is debug, so nothing is filtered out. Server
 * tests that assert on log lines use this rather than a sink of their own.
 */
export function captureLog(level: LogLevel = 'debug') {
  const lines: string[] = [];
  const errors = createErrorWindow();
  const log = createLogger({ level, sink: (line) => lines.push(line), onError: () => errors.record() });
  const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, lines, events, errors };
}

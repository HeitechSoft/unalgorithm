/**
 * Structured logging for the server: one JSON object per line. Fields are flat primitives only, so a request body,
 * a post or a prompt cannot be passed in by accident, and strings are cut short. Errors go through `errorFields`,
 * which never returns the message: provider errors can echo prompt text.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds these fields to every line (a request id, say). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Receives each line, newline included. Default: standard output. */
  sink?: (line: string) => void;
}

/** Every string field is cut to this many characters, `err_stack` included. */
const MAX_STRING = 200;
/** Keys every line has; fields never replace them. */
const FIXED_KEYS = new Set(['t', 'level', 'event']);

export function createLogger({ level, sink = (line) => process.stdout.write(line) }: LoggerOptions): Logger {
  const min = LOG_LEVELS.indexOf(level);

  function make(base: LogFields): Logger {
    const write = (lvl: LogLevel) => (event: string, fields?: LogFields) => {
      if (LOG_LEVELS.indexOf(lvl) < min) return;
      const line: Record<string, string | number | boolean | null> = { t: new Date().toISOString(), level: lvl, event };
      for (const [key, value] of Object.entries({ ...base, ...fields })) {
        if (FIXED_KEYS.has(key)) continue;
        if (typeof value === 'string') line[key] = value.slice(0, MAX_STRING);
        else if (typeof value === 'number' || typeof value === 'boolean' || value === null) line[key] = value;
        // Anything else (undefined, or an object smuggled past the types) is dropped.
      }
      sink(`${JSON.stringify(line)}\n`);
    };
    return {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
      child: (fields) => make({ ...base, ...fields }),
    };
  }

  return make({});
}

export type ErrorFields = { err_name: string; err_code?: string | number; err_stack?: string };

const MAX_FRAMES = 10;
const FRAME = /^\s+at /;

/**
 * Loggable facts about an error: its name, its code and its top stack frames, at most 10 and only as many whole frames
 * as fit in the logger's 200-character cut. Never its message, which can hold provider response text and so post
 * text. Frames are read only after the message in the stack, so a multi-line message cannot pass for frames; when the
 * message cannot be found there, the stack is left out.
 */
export function errorFields(err: unknown): ErrorFields {
  if (typeof err !== 'object' || err === null) return { err_name: 'NonError' };
  const e = err as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  const out: ErrorFields = { err_name: err instanceof Error && typeof e.name === 'string' ? e.name : 'NonError' };
  if (typeof e.code === 'string' || typeof e.code === 'number') out.err_code = e.code;
  if (typeof e.stack === 'string') {
    const message = typeof e.message === 'string' ? e.message : '';
    const at = message ? e.stack.indexOf(message) : 0;
    if (at >= 0) {
      const rest = e.stack
        .slice(at + message.length)
        .split('\n')
        .slice(1);
      const frames = rest
        .filter((line) => FRAME.test(line))
        .slice(0, MAX_FRAMES)
        .map((line) => line.trim());
      let stack = frames[0]?.slice(0, MAX_STRING) ?? '';
      for (const frame of frames.slice(1)) {
        if (stack.length + 1 + frame.length > MAX_STRING) break;
        stack += `\n${frame}`;
      }
      if (stack) out.err_stack = stack;
    }
  }
  return out;
}

/**
 * Hybrid logical clock: wall time plus a counter plus the device id, so every edit gets a unique, ordered stamp
 * even when two devices edit in the same millisecond or their clocks drift. Settings sync (Phase 2) merges field
 * by field and keeps the higher stamp. Format: `<ms base36, 9 chars>:<counter base36, 4 chars>:<deviceId>`, which
 * also sorts correctly as a plain string.
 */
export interface Hlc {
  ms: number;
  counter: number;
  device: string;
}

export const HLC_ZERO = '000000000:0000:0';

export function formatHlc(h: Hlc): string {
  return `${h.ms.toString(36).padStart(9, '0')}:${h.counter.toString(36).padStart(4, '0')}:${h.device}`;
}

export function parseHlc(s: string): Hlc {
  const [ms = '0', counter = '0', ...device] = s.split(':');
  return { ms: Number.parseInt(ms, 36), counter: Number.parseInt(counter, 36), device: device.join(':') };
}

/** Next stamp for a local event, given the last stamp this device issued or saw. */
export function tickHlc(last: string | undefined, device: string, now = Date.now()): string {
  const prev = last ? parseHlc(last) : { ms: 0, counter: 0, device };
  if (now > prev.ms) return formatHlc({ ms: now, counter: 0, device });
  return formatHlc({ ms: prev.ms, counter: prev.counter + 1, device });
}

export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

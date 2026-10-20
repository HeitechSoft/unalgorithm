import { z } from 'zod';

/**
 * zod compiles fast parsers with `new Function`, after probing whether eval works. Extension pages, the background and
 * content scripts all forbid eval, and Firefox reports every refused probe, so zod runs without it here. The setting
 * is read when each schema is built, so wxt.config.ts imports this module ahead of everything else in every entrypoint.
 */
z.config({ jitless: true });

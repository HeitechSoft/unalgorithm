/** The outlet registry, browser-safe (the extension bundles this entry): no `node:` import here or below. */
import data from '../data/registry.json' with { type: 'json' };
import { type Registry, RegistrySchema } from './schema.ts';

export * from './schema.ts';

let bundled: Registry | null | undefined;

/** The registry shipped in `data/registry.json`, parsed once; null when it is invalid. */
export function bundledRegistry(): Registry | null {
  if (bundled === undefined) {
    const parsed = RegistrySchema.safeParse(data);
    bundled = parsed.success ? parsed.data : null;
  }
  return bundled;
}

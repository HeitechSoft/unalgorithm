/**
 * `node packages/outlets/src/cli.ts <command>`: the registry's validation, signing and build gate.
 *
 * - `validate [file]`: prints every problem; exit 1 when any.
 * - `sign --key <path>`: signs a sound `reviewed` registry with the panel's private key and writes the signature file.
 *   Refuses anything else. Never prints the key.
 * - `verify [file]`: exit 0 only when the signature verifies with the panel public key.
 * - `check`: the build gate. Fails on any problem, on a `fixture` registry (never bundled), and for a `reviewed` one on
 *   a missing or failing signature or a missing public key. A draft with every `lean: null` passes: it ships, and the
 *   runtime rule (`usableRegistry`) keeps perspectives hidden.
 *
 * Paths default to `data/registry.json`, `data/registry.sig` and `keys/panel-ed25519.pub` in this package and are
 * overridden with `--file`, `--sig` and `--pub`. Output names outlet ids and rules only. Exit 2 for a usage error.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Registry, RegistrySchema, registryProblems } from './schema.ts';
import { signRegistry, verifyRegistry } from './sign.ts';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: outlets <validate [file] | sign --key <path> | verify [file] | check> [--file f] [--sig f] [--pub f]';

interface Io {
  out(line: string): void;
}

interface Args {
  cmd: string | undefined;
  file: string;
  sig: string;
  pub: string;
  key: string | undefined;
}

function parseArgs(argv: readonly string[]): Args | string {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const value = argv[++i];
      if (!['file', 'sig', 'pub', 'key'].includes(name) || value === undefined) return `Unknown or incomplete option ${a}.`;
      flags[name] = value;
    } else positional.push(a);
  }
  const [cmd, file, ...rest] = positional;
  if (rest.length > 0) return `Unexpected argument ${rest[0]}.`;
  return {
    cmd,
    file: resolve(flags.file ?? file ?? join(PKG, 'data', 'registry.json')),
    sig: resolve(flags.sig ?? join(PKG, 'data', 'registry.sig')),
    pub: resolve(flags.pub ?? join(PKG, 'keys', 'panel-ed25519.pub')),
    key: flags.key,
  };
}

function readJson(path: string): { raw: unknown } | { error: string } {
  try {
    return { raw: JSON.parse(readFileSync(path, 'utf8')) as unknown };
  } catch (e) {
    return { error: e instanceof SyntaxError ? 'registry is not valid JSON' : 'registry file cannot be read' };
  }
}

/** The registry when it is sound; otherwise prints its problems and returns null. */
function load(path: string, io: Io): Registry | null {
  const read = readJson(path);
  if ('error' in read) {
    io.out(`(root): ${read.error}`);
    return null;
  }
  const problems = registryProblems(read.raw);
  for (const p of problems) io.out(p);
  return problems.length === 0 ? RegistrySchema.parse(read.raw) : null;
}

function signatureVerifies(reg: Registry, args: Args, io: Io): boolean {
  if (!existsSync(args.pub)) {
    io.out('signature: the panel public key is missing');
    return false;
  }
  if (!existsSync(args.sig)) {
    io.out('signature: the registry signature is missing');
    return false;
  }
  if (!verifyRegistry(reg, readFileSync(args.sig, 'utf8'), readFileSync(args.pub, 'utf8'))) {
    io.out('signature: does not verify with the panel public key');
    return false;
  }
  return true;
}

export async function main(argv: readonly string[], io: Io = { out: (line) => console.log(line) }): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    io.out(`${args} ${USAGE}`);
    return 2;
  }

  switch (args.cmd) {
    case 'validate': {
      const reg = load(args.file, io);
      if (reg) io.out(`ok: ${reg.meta.status} registry ${reg.meta.version}, ${reg.outlets.length} outlets`);
      return reg ? 0 : 1;
    }
    case 'sign': {
      if (!args.key) {
        io.out(`sign needs --key <path>. ${USAGE}`);
        return 2;
      }
      const reg = load(args.file, io);
      if (!reg) return 1;
      if (reg.meta.status !== 'reviewed') {
        io.out(`meta.status: only a reviewed registry is signed (this one is ${reg.meta.status})`);
        return 1;
      }
      let signature: string;
      try {
        signature = signRegistry(reg, readFileSync(args.key, 'utf8'));
      } catch {
        io.out('key: not a readable Ed25519 private key');
        return 1;
      }
      writeFileSync(args.sig, `${signature}\n`);
      io.out(`signed: ${reg.meta.version}`);
      return 0;
    }
    case 'verify': {
      const read = readJson(args.file);
      if ('error' in read) {
        io.out(`(root): ${read.error}`);
        return 1;
      }
      const parsed = RegistrySchema.safeParse(read.raw);
      if (!parsed.success) {
        io.out('(root): not a registry');
        return 1;
      }
      const ok = signatureVerifies(parsed.data, args, io);
      if (ok) io.out(`verified: ${parsed.data.meta.version}`);
      return ok ? 0 : 1;
    }
    case 'check': {
      const reg = load(args.file, io);
      if (!reg) return 1;
      if (reg.meta.status === 'fixture') {
        io.out('meta.status: a fixture registry is never bundled');
        return 1;
      }
      if (reg.meta.status === 'reviewed' && !signatureVerifies(reg, args, io)) return 1;
      io.out(
        reg.meta.status === 'draft'
          ? `ok: draft registry ${reg.meta.version}, no lean labels; perspectives stays hidden`
          : `ok: reviewed registry ${reg.meta.version}, signed by the panel`,
      );
      return 0;
    }
    default:
      io.out(USAGE);
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}

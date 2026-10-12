import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  findHostMarkers,
  findPublicIPv4,
  findSecretPaths,
  formatFinding,
  isPublicIPv4,
  parseIpAllowlist,
} from '../../../scripts/scan-public-repo.mjs';

/**
 * Builds a dotted address at runtime. This file needs real public addresses, but holds no public-address literal, so
 * the IPv4 rule needs no exception for it, in the tree or in history.
 */
const pub = (...octets: number[]) => octets.join('.');
const RESOLVER_A = pub(8, 8, 8, 8);
const RESOLVER_B = pub(9, 9, 9, 9);

/** A private-key header, built at runtime so no secret scanner reads this file as holding a key. */
const keyHeader = (type: string) => `${'-'.repeat(5)}BEGIN ${type}PRIVATE KEY${'-'.repeat(5)}`;

const SCRIPT = fileURLToPath(new URL('../../../scripts/scan-public-repo.mjs', import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * A throwaway repository that ignores the developer's own git configuration, scanned with one extra marker. It is
 * removed when the test finishes.
 */
function throwawayRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ua-scan-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(dir, 'none'),
    GIT_CONFIG_NOSYSTEM: '1',
    PUBLIC_SCAN_EXTRA_PATTERNS: 'example-host-7',
  };
  const run = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=Scan Test', '-c', 'user.email=scan@example.org', ...args], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
  const git = (...args: string[]) => {
    const result = run(...args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  mkdirSync(repo);
  git('init', '-q');
  return {
    dir,
    run,
    git,
    write(file: string, text: string) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), text);
    },
    scan: (script = SCRIPT) => spawnSync(process.execPath, [script, repo], { env, encoding: 'utf8' }),
  };
}

describe('IPv4', () => {
  it('test_is_public_ipv4_ranges', () => {
    expect(isPublicIPv4(RESOLVER_A)).toBe(true);
    expect(isPublicIPv4(RESOLVER_B)).toBe(true);
    const notPublic = [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '169.254.1.1',
      '192.0.2.10',
      '198.51.100.7',
      '203.0.113.9',
      '0.0.0.0',
      '224.0.0.1',
      '256.1.1.1',
    ];
    for (const address of notPublic) expect([address, isPublicIPv4(address)]).toEqual([address, false]);

    // Range edges: the first and last address inside each block, and its public neighbours.
    for (const address of ['172.16.0.0', '172.31.255.255', '100.127.255.255', '198.19.255.255', '255.255.255.255'])
      expect([address, isPublicIPv4(address)]).toEqual([address, false]);
    for (const address of [pub(172, 15, 255, 255), pub(172, 32, 0, 0), pub(100, 128, 0, 0), pub(198, 20, 0, 0)])
      expect([address, isPublicIPv4(address)]).toEqual([address, true]);
    expect(isPublicIPv4(pub(223, 255, 255, 255))).toBe(true);
    expect(isPublicIPv4('1.2.3')).toBe(false);
    expect(isPublicIPv4(`${RESOLVER_A}.5`)).toBe(false);
  });

  it('test_find_public_ipv4_ignores_long_versions', () => {
    expect(findPublicIPv4(`version 1.2.3.4.5 and host ${RESOLVER_A}`)).toEqual([RESOLVER_A]);
    expect(findPublicIPv4(`The host is ${RESOLVER_A}.`)).toEqual([RESOLVER_A]);
    expect(findPublicIPv4(`see...${RESOLVER_A}`)).toEqual([RESOLVER_A]);
    expect(findPublicIPv4('1.2.3.4.5')).toEqual([]);
    expect(findPublicIPv4(`${RESOLVER_A}.5`)).toEqual([]);
    expect(findPublicIPv4(`listen ${RESOLVER_B}:443; allow ${RESOLVER_A}/32; and 127.0.0.1`)).toEqual([RESOLVER_B, RESOLVER_A]);
  });

  it('test_ip_allowlist_respected', () => {
    const allowlist = parseIpAllowlist(`# header\n\n${RESOLVER_A}  # a public resolver named in a doc\r\n`);
    expect([...allowlist]).toEqual([RESOLVER_A]);
    expect(findPublicIPv4(`${RESOLVER_A} and ${RESOLVER_B}`, allowlist)).toEqual([RESOLVER_B]);

    // Every entry needs a reason, and nothing but an address is allowed.
    expect(() => parseIpAllowlist(RESOLVER_A)).toThrow(/line 1/);
    expect(() => parseIpAllowlist(`# header\nexample.org  # not an address`)).toThrow(/line 2/);
    // The committed allowlist parses.
    const committed = readFileSync(new URL('../../../scripts/ip-allowlist.txt', import.meta.url), 'utf8');
    expect(() => parseIpAllowlist(committed)).not.toThrow();
  });
});

describe('host markers', () => {
  it('test_host_markers_found_with_lines', () => {
    const text = [
      'ssh ubuntu@host uptime',
      'pscp -i C:\\keys\\deploy.PPK site.tar',
      keyHeader('OPENSSH '),
      'nano /opt/unalgorithm/.env',
      '    proxy_pass http://127.0.0.1:8787;',
      '    server_name example.org;',
      '    ssl_certificate /etc/ssl/site.crt;',
      'nothing to see here',
    ].join('\n');
    expect(findHostMarkers(text)).toEqual([
      { line: 1, kind: 'host-marker', text: 'ubuntu@' },
      { line: 2, kind: 'host-marker', text: '.PPK' },
      { line: 3, kind: 'host-marker', text: keyHeader('OPENSSH ') },
      { line: 4, kind: 'host-marker', text: '/opt/unalgorithm/.env' },
      { line: 5, kind: 'host-marker', text: 'proxy_pass ' },
      { line: 6, kind: 'host-marker', text: 'server_name ' },
      { line: 7, kind: 'host-marker', text: 'ssl_certificate' },
    ]);
    expect(findHostMarkers(`a\r\n${keyHeader('')}\r\n`)).toEqual([{ line: 2, kind: 'host-marker', text: keyHeader('') }]);

    // An ignore rule or prose naming the extension is not a key path.
    expect(findHostMarkers('*.ppk\nNever commit a .ppk file.')).toEqual([]);
    // The scanner and its test skip the generic markers, as they contain them.
    expect(findHostMarkers(text, { generic: false })).toEqual([]);
  });

  it('test_extra_markers_from_env_not_printed', () => {
    vi.stubEnv('PUBLIC_SCAN_EXTRA_PATTERNS', 'example-host-7');
    const findings = findHostMarkers('first line\nconnect to Example-Host-7 now');
    expect(findings).toEqual([{ line: 2, kind: 'extra-marker', marker: 1 }]);
    const report = findings.map((f) => formatFinding({ file: 'docs/notes.md', ...f })).join('\n');
    expect(report).toBe('docs/notes.md:2  extra-marker #1');
    expect(`${report}\n${JSON.stringify(findings)}`.toLowerCase()).not.toContain('example-host-7');

    // Extra markers are checked even where the generic ones are skipped.
    expect(findHostMarkers('Example-Host-7', { generic: false })).toEqual([{ line: 1, kind: 'extra-marker', marker: 1 }]);

    // Read at call time; the number is the pattern's line in the secret, blank lines included.
    vi.stubEnv('PUBLIC_SCAN_EXTRA_PATTERNS', 'unused-name-q\n\n  example-host-7  \r\n');
    expect(findHostMarkers('EXAMPLE-HOST-7')).toEqual([{ line: 1, kind: 'extra-marker', marker: 3 }]);
    vi.stubEnv('PUBLIC_SCAN_EXTRA_PATTERNS', '');
    expect(findHostMarkers('Example-Host-7')).toEqual([]);
  });

  it('test_putty_key_found_by_path_and_content', () => {
    const key = ['PuTTY-User-Key-File-3: ssh-ed25519', 'Encryption: none', 'Comment: deploy'].join('\n');
    expect(findSecretPaths(['README.md', 'deploy/k.ppk', '.env.example', 'apps/server/.env.example'])).toEqual(['deploy/k.ppk']);
    expect(findHostMarkers(key)).toEqual([{ line: 1, kind: 'host-marker', text: 'PuTTY-User-Key-File-' }]);

    const paths = [
      '.env',
      'apps/server/.env.production',
      'certs/site.PEM',
      'certs/site.p12',
      'certs/site.pfx',
      'keys/id_ed25519',
      'id_rsa',
      'keys/id_ed25519.pub',
      'docs/environment.md',
      'src/.envrc',
      'apps/server/src/env.ts',
    ];
    expect(findSecretPaths(paths)).toEqual(paths.slice(0, 7));
  });
});

describe('output and self-check', () => {
  it('test_format_finding_hides_addresses_and_patterns', () => {
    const commit = 'a'.repeat(40);
    expect(formatFinding({ file: 'docs/a.md', line: 3, kind: 'public-ipv4' })).toBe('docs/a.md:3  public-ipv4');
    expect(formatFinding({ commit, file: 'docs/a.md', kind: 'public-ipv4' })).toBe(`${commit} docs/a.md  public-ipv4`);
    expect(formatFinding({ commit, file: 'docs/a.md', line: 9, kind: 'public-ipv4' })).toBe(`${commit} docs/a.md:9  public-ipv4`);
    // Matched text is printed for generic host markers only, never for an address or an extra marker.
    expect(formatFinding({ file: 'docs/a.md', line: 3, kind: 'public-ipv4', text: RESOLVER_A })).not.toContain(RESOLVER_A);
    expect(formatFinding({ file: 'x.md', line: 1, kind: 'extra-marker', marker: 2, text: 'example-host-7' })).toBe(
      'x.md:1  extra-marker #2',
    );
    expect(formatFinding({ file: 'ops.md', line: 4, kind: 'host-marker', text: 'ubuntu@' })).toBe(
      'ops.md:4  host-marker ubuntu@',
    );
    expect(formatFinding({ file: 'deploy/k.ppk', kind: 'secret-path' })).toBe('deploy/k.ppk  secret-path');
  });

  it('test_scan_test_source_has_no_public_literal', () => {
    const source = readFileSync(new URL(import.meta.url), 'utf8');
    expect(findPublicIPv4(source)).toEqual([]);
    expect(findPublicIPv4(`${RESOLVER_A} ${RESOLVER_B}`)).toEqual([RESOLVER_A, RESOLVER_B]);
  });

  it('test_cli_fails_on_a_committed_public_address', () => {
    const repo = throwawayRepo();
    repo.write('notes.md', 'local only: 127.0.0.1\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'clean');
    const clean = repo.scan();
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.stdout).toContain('extra markers: 1');
    expect(clean.stdout).toContain('public repo scan: 0 findings');

    repo.write('notes.md', `local only: 127.0.0.1\nthe host is ${RESOLVER_A}.\n`);
    repo.git('commit', '-q', '-am', 'leak');
    const commit = repo.git('rev-parse', 'HEAD');
    const leak = repo.scan();
    expect(leak.status).toBe(1);
    expect(leak.stdout).toContain('notes.md:2  public-ipv4');
    expect(leak.stdout).toContain(`${commit} notes.md:2  public-ipv4`);
    expect(leak.stdout).toContain('public repo scan: 2 findings');
    expect(leak.stdout + leak.stderr).not.toContain(RESOLVER_A);
  });

  it('test_cli_scans_merge_resolutions', () => {
    // An address added while resolving a conflict, and removed by the next commit, stays in the merge commit.
    const repo = throwawayRepo();
    repo.write('f.txt', 'base\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'base');
    repo.git('checkout', '-q', '-b', 'side');
    repo.write('f.txt', 'side\n');
    repo.git('commit', '-q', '-am', 'side');
    repo.git('checkout', '-q', '-');
    repo.write('f.txt', 'main\n');
    repo.git('commit', '-q', '-am', 'main');
    expect(repo.run('merge', '-q', 'side').status).toBe(1);
    repo.write('f.txt', `main side host ${RESOLVER_A}\n`);
    repo.git('commit', '-q', '-am', 'merge');
    const merge = repo.git('rev-parse', 'HEAD');
    repo.write('f.txt', 'main side\n');
    repo.git('commit', '-q', '-am', 'clean');

    const result = repo.scan();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${merge} f.txt:1  public-ipv4`);
    expect(result.stdout).toContain('public repo scan: 1 findings');
  });

  it('test_cli_hides_paths_that_hold_an_address_or_extra_marker', () => {
    const repo = throwawayRepo();
    repo.write('deploy/example-host-7.conf', '  server_name example.org;\n');
    repo.write(`deploy/known-host-${RESOLVER_A}.txt`, 'ok\n');
    repo.write('notes.md', 'ok\n');
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'paths');
    const commit = repo.git('rev-parse', 'HEAD');

    const result = repo.scan();
    expect(result.status).toBe(1);
    // Paths are numbered by `git ls-files` in the tree and by the commit's diff in history.
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      'extra markers: 1',
      'path #1  extra-marker #1',
      'path #2  public-ipv4',
      'path #1:1  host-marker server_name ',
      `${commit} path #1  extra-marker #1`,
      `${commit} path #1:1  host-marker server_name `,
      `${commit} path #2  public-ipv4`,
      'public repo scan: 6 findings',
    ]);
    const output = (result.stdout + result.stderr).toLowerCase();
    for (const hidden of ['example-host-7', 'known-host', RESOLVER_A]) expect(output).not.toContain(hidden);
  });

  it('test_cli_runs_through_a_linked_path', () => {
    // Node runs the real path of a linked entry script; the scan must still run (and fail) rather than do nothing.
    const repo = throwawayRepo();
    repo.write('notes.md', `the host is ${RESOLVER_A}\n`);
    repo.git('add', '.');
    repo.git('commit', '-q', '-m', 'leak');
    // A copy, so the link never points into the checkout. A junction on Windows, a directory symlink elsewhere.
    const real = join(repo.dir, 'real', 'scripts');
    mkdirSync(real, { recursive: true });
    for (const name of ['scan-public-repo.mjs', 'ip-allowlist.txt']) copyFileSync(join(dirname(SCRIPT), name), join(real, name));
    symlinkSync(join(repo.dir, 'real'), join(repo.dir, 'link'), 'junction');

    const direct = repo.scan();
    const linked = repo.scan(join(repo.dir, 'link', 'scripts', 'scan-public-repo.mjs'));
    expect(direct.status).toBe(1);
    expect([linked.status, linked.stdout]).toEqual([1, direct.stdout]);
  });
});

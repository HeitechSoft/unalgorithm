#!/usr/bin/env node
/**
 * Fails if the public repository holds a host address, a host marker or a key file, in a tracked file or anywhere in
 * its history (every ref). Rules:
 * - public IPv4 addresses: outside the private, shared, reserved and documentation ranges, and not reviewed in
 *   scripts/ip-allowlist.txt;
 * - generic host markers: SSH logins on the host, PuTTY and PEM private keys, the Cloud deployment's env file and
 *   nginx server-block syntax;
 * - extra markers: host-specific names and addresses from PUBLIC_SCAN_EXTRA_PATTERNS (a CI secret, one per line);
 * - key files by path (tracked files only);
 * - binary files: a file holding a NUL byte is read as UTF-16 (with or without a byte order mark, as Windows PowerShell
 *   5.1's `>` and Out-File write it) when it looks like it, and is otherwise a finding unless its type is a known
 *   binary one, so a new binary needs a review instead of passing unseen. History reads such a file from the commit,
 *   as git shows no lines for it.
 * File paths are checked for public IPv4 addresses and extra markers too, in the tree and in history.
 * Findings never print an address or an extra marker, so CI logs cannot republish what this scan keeps out of the
 * repository: read the reported line locally. A path that holds either is printed as `path #<n>`: the n-th path of
 * `git ls-files`, or the n-th file in that commit's diff. History findings are added lines, named by commit, file and
 * line; for a merge, the lines that differ from git's own automatic merge (such as a conflict resolution).
 *
 * Usage: node scripts/scan-public-repo.mjs [repository]   (default: the repository holding this script)
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A dotted quad that is not part of a longer dotted number (`1.2.3.4.5`), though it may end a sentence. */
const IPV4 = /(?<!\d\.?)(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g;

/** Blocks that are not publicly routable, as [first address, prefix length]. */
const NOT_PUBLIC = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (carrier-grade NAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 3], // multicast (224.0.0.0/4) and everything above it
].map(([first, bits]) => ({ block: blockOf(toNumber(octets(first)), bits), bits }));

/**
 * Generic host markers, matched case-insensitively unless noted. A finding prints the matched text: the marker itself,
 * no more.
 */
const HOST_MARKERS = [
  /ubuntu@/i, // an SSH login on the host
  /(?<=[\w-])\.ppk\b/i, // a PuTTY key file's path (an ignore rule `*.ppk`, or prose about the extension, is not one)
  /PuTTY-User-Key-File-/i, // a PuTTY key's first line
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i, // a PEM or OpenSSH private key
  /\/opt\/unalgorithm\/\.env/i, // the Cloud deployment's env file
  // nginx server-block syntax. The directive is lowercase and takes names up to `;`, so a code name such as
  // `MAX_SERVER_NAME = 80;` is not one. The names (perhaps the host's) stay out of the match, so they are never printed.
  /\bserver_name\s(?=\s*[^\s;=][^;]*;)/,
  /proxy_pass /i,
  /ssl_certificate/i,
];

/** These two contain the generic markers, so they skip those (only those) in the tree and in history. */
const SELF = new Set(['scripts/scan-public-repo.mjs', 'apps/server/test/scan.test.ts']);

/** The types .gitattributes marks binary: their content is not scanned, in the tree or in history. */
const KNOWN_BINARY = /\.(png|ico|zip)$/i;

const SECRET_PATH = /\.ppk$|\.p12$|\.pfx$|\.pem$|(^|\/)id_(rsa|ecdsa|ed25519)$|(^|\/)\.env(\..+)?$/i;
const ENV_EXAMPLE = /(^|\/)\.env\.example$/;

/** The four parts of an exact dotted quad, or undefined. */
function octets(address) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  return m ? m.slice(1).map(Number) : undefined;
}

function toNumber(parts) {
  return parts.reduce((n, part) => n * 256 + part, 0);
}

function blockOf(n, bits) {
  return Math.floor(n / 2 ** (32 - bits));
}

/** True for a dotted quad that is a valid, publicly routable IPv4 address. */
export function isPublicIPv4(address) {
  const parts = octets(address);
  if (!parts || parts.some((part) => part > 255)) return false;
  const n = toNumber(parts);
  return !NOT_PUBLIC.some(({ block, bits }) => blockOf(n, bits) === block);
}

/** The public IPv4 addresses in `text`, in order, except reviewed ones. */
export function findPublicIPv4(text, allowlist = new Set()) {
  return [...text.matchAll(IPV4)].map((m) => m[0]).filter((address) => isPublicIPv4(address) && !allowlist.has(address));
}

/** Reads scripts/ip-allowlist.txt: `<address>  # reason` per line; blank lines and `#` comments are skipped. */
export function parseIpAllowlist(text) {
  const allowed = new Set();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [, address = ''] = /^(\S+)\s+#\s*\S/.exec(line) ?? [];
    // The message names the line only, never its content.
    if (!octets(address)) throw new Error(`ip-allowlist.txt line ${i + 1}: expected "<address>  # reason"`);
    allowed.add(address);
  });
  return allowed;
}

/** PUBLIC_SCAN_EXTRA_PATTERNS, read at call time: lowercased substrings, numbered by their line in the secret. */
function extraMarkers() {
  return (process.env.PUBLIC_SCAN_EXTRA_PATTERNS ?? '').split(/\r?\n/).flatMap((raw, i) => {
    const pattern = raw.trim().toLowerCase();
    return pattern ? [{ marker: i + 1, pattern }] : [];
  });
}

/** Host-marker findings in one line. An extra marker carries only its number, never the pattern or the match. */
function markersIn(content, generic, extra) {
  const found = [];
  if (generic) {
    for (const marker of HOST_MARKERS) {
      const m = marker.exec(content);
      if (m) found.push({ kind: 'host-marker', text: m[0] });
    }
  }
  const lower = content.toLowerCase();
  for (const { marker, pattern } of extra) if (lower.includes(pattern)) found.push({ kind: 'extra-marker', marker });
  return found;
}

/**
 * Generic and extra host markers in `text`, with 1-based line numbers. `generic: false` checks the extra markers only
 * (for this scanner and its test).
 */
export function findHostMarkers(text, { generic = true } = {}) {
  const extra = extraMarkers();
  return text.split(/\r?\n/).flatMap((content, i) => markersIn(content, generic, extra).map((f) => ({ line: i + 1, ...f })));
}

/** Tracked paths that look like key files or env files (`.env.example` is fine). */
export function findSecretPaths(paths) {
  return paths.filter((path) => SECRET_PATH.test(path) && !ENV_EXAMPLE.test(path));
}

/**
 * One report line: `file:line  kind`, or `commit file:line  kind` for history. Only a generic host marker adds its
 * matched text; an address or an extra marker is never printed, so CI logs never republish one.
 */
export function formatFinding({ commit, file, line, kind, text, marker }) {
  const where = `${commit ? `${commit} ` : ''}${file}${line ? `:${line}` : ''}`;
  if (kind === 'host-marker') return `${where}  host-marker ${text}`;
  if (kind === 'extra-marker') return `${where}  extra-marker #${marker}`;
  return `${where}  ${kind}`;
}

/**
 * Every content rule over one line or one path, without its location. `generic: false` skips the generic host markers
 * (for paths, and for this scanner and its test).
 */
function textFindings(text, { allowlist, extra }, generic) {
  const found = findPublicIPv4(text, allowlist).length ? [{ kind: 'public-ipv4' }] : [];
  return found.concat(markersIn(text, generic, extra));
}

/**
 * The text of a file's bytes, or undefined for binary bytes. Bytes without a NUL in their first 8 KiB are UTF-8. UTF-16
 * is read by its byte order mark, or without one when a NUL fills at least half its code units, nearly all on one side
 * (text in a Latin script), and the result has no control characters. Anything else holding a NUL is binary, UTF-8 text
 * with a stray NUL included, so its lines are never decoded away.
 */
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const sample = bytes.subarray(0, 8192);
  if (!sample.includes(0)) return new TextDecoder().decode(bytes);
  let even = 0;
  let odd = 0;
  for (let i = 0; i + 1 < sample.length; i += 2) {
    if (sample[i] === 0) even++;
    if (sample[i + 1] === 0) odd++;
  }
  const units = Math.floor(sample.length / 2);
  const encoding = odd * 2 >= units && even * 10 < odd ? 'utf-16le' : even * 2 >= units && odd * 10 < even ? 'utf-16be' : '';
  const text = encoding ? new TextDecoder(encoding).decode(bytes) : '';
  return encoding && looksLikeText(text) ? text : undefined;
}

/** True when `text` has no control character other than whitespace in its first 4096 code units. */
function looksLikeText(text) {
  for (let i = 0; i < Math.min(text.length, 4096); i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && (c < 0x09 || c > 0x0d)) return false;
  }
  return true;
}

/**
 * Findings in one file's content: every content rule per line, with 1-based line numbers, or one binary-file finding
 * for binary bytes. A known binary type is not read.
 */
function* contentFindings(bytes, file, rules) {
  if (KNOWN_BINARY.test(file)) return;
  const text = decodeText(bytes);
  if (text === undefined) {
    yield { kind: 'binary-file' };
    return;
  }
  for (const [i, content] of text.split(/\r?\n/).entries()) {
    for (const f of textFindings(content, rules, !SELF.has(file))) yield { line: i + 1, ...f };
  }
}

function* trackedFindings(root, rules) {
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
  // A path that holds an address or an extra marker is printed as its position in `git ls-files`, never by name.
  const shown = new Map();
  for (const [i, file] of paths.entries()) {
    const found = textFindings(file, rules, false);
    shown.set(file, found.length ? `path #${i + 1}` : file);
    for (const f of found) yield { file: shown.get(file), ...f };
  }
  for (const file of findSecretPaths(paths)) yield { file: shown.get(file), kind: 'secret-path' };
  for (const file of paths) {
    let bytes;
    try {
      bytes = readFileSync(join(root, file));
    } catch (err) {
      // Deleted in the work tree (history still has it) or a submodule.
      if (err.code === 'ENOENT' || err.code === 'EISDIR') continue;
      throw err;
    }
    for (const f of contentFindings(bytes, file, rules)) yield { file: shown.get(file), ...f };
  }
}

/** Lines of a stream, split on `\n` only: a lone `\r` inside a line must not shift the hunk counts. */
async function* linesOf(stream) {
  stream.setEncoding('utf8');
  let rest = '';
  for await (const chunk of stream) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop() ?? '';
    for (const part of parts) yield part.endsWith('\r') ? part.slice(0, -1) : part;
  }
  if (rest) yield rest;
}

/** `+++ b/<path>` (git adds a tab after a path with spaces, and quotes unusual ones) to the path. */
function headerPath(header) {
  const path = header.replace(/\t$/, '').replace(/^"(.*)"$/, '$1');
  return path.startsWith('b/') ? path.slice(2) : path;
}

/**
 * Added lines in every commit of every ref, streamed: the patch output of all refs is far above execFileSync's
 * default buffer. Hunk headers give each added line's number in the commit's version of the file. A merge shows the
 * lines that differ from git's own automatic merge (`--diff-merges=remerge`, git 2.36 or later), so an address added
 * while resolving a conflict is scanned too. For a file git shows as binary (`Binary files ... differ`, UTF-16 text
 * included), the commit's version of it is read by its blob id.
 */
async function* historyFindings(root, rules) {
  const git = spawn(
    'git',
    [
      ...['-c', 'core.quotePath=false', '-c', 'log.showRoot=true', 'log', '--all', '-p', '--diff-merges=remerge'],
      ...['--no-color', '--no-ext-diff', '--no-textconv', '--no-decorate', '--full-index'],
      ...['--src-prefix=a/', '--dst-prefix=b/'],
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = new Promise((done, fail) => {
    git.on('error', fail);
    git.on('close', done);
  });
  let commit = '';
  let file = '';
  let shown = '';
  let fileNo = 0;
  let blob = '';
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for await (const text of linesOf(git.stdout)) {
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith('+')) {
        const found = textFindings(text.slice(1), rules, !SELF.has(file));
        for (const f of found) yield { commit, file: shown || file, line, ...f };
        newLeft--;
        line++;
      } else if (text.startsWith('-')) {
        oldLeft--;
      } else if (!text.startsWith('\\')) {
        oldLeft--;
        newLeft--;
        line++;
      }
      continue;
    }
    if (text.startsWith('commit ')) {
      commit = text.slice(7).split(' ')[0] ?? '';
      file = '';
      shown = '';
      fileNo = 0;
    } else if (text.startsWith('diff --git ')) {
      // Both paths of one file's diff (old and new). One that holds an address or an extra marker is printed as the
      // file's position in the commit's diff, never by name.
      fileNo++;
      const found = textFindings(text.slice(11), rules, false);
      shown = found.length ? `path #${fileNo}` : '';
      file = '';
      blob = '';
      for (const f of found) yield { commit, file: shown, ...f };
    } else if (text.startsWith('index ')) {
      blob = /^index [0-9a-f]+\.\.([0-9a-f]+)/.exec(text)?.[1] ?? '';
    } else if (text.startsWith('Binary files ') && /[1-9a-f]/.test(blob)) {
      // The new side's path (after the last " and "). A deleted file's new blob id is all zeros: nothing to read.
      const path = headerPath(/^Binary files .* and (.*) differ$/.exec(text)?.[1] ?? '');
      if (!KNOWN_BINARY.test(path)) {
        const bytes = execFileSync('git', ['cat-file', 'blob', blob], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
        for (const f of contentFindings(bytes, path, rules)) yield { commit, file: shown || path, ...f };
      }
    } else if (text.startsWith('+++ ')) {
      file = headerPath(text.slice(4));
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
      if (hunk) {
        oldLeft = Number(hunk[1] ?? 1);
        line = Number(hunk[2]);
        newLeft = Number(hunk[3] ?? 1);
      }
    }
  }
  const code = await exited;
  if (code !== 0) throw new Error(`git log exited with code ${code}`);
}

async function main() {
  const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
  const rules = {
    allowlist: parseIpAllowlist(readFileSync(new URL('ip-allowlist.txt', import.meta.url), 'utf8')),
    extra: extraMarkers(),
  };
  // The count only, so a run shows whether the secret was present (fork PRs get no secrets).
  console.log(`extra markers: ${rules.extra.length}`);
  let count = 0;
  const report = (finding) => {
    count++;
    console.log(formatFinding(finding));
  };
  for (const finding of trackedFindings(root, rules)) report(finding);
  for await (const finding of historyFindings(root, rules)) report(finding);
  console.log(`public repo scan: ${count} findings`);
  if (count) process.exitCode = 1;
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when node runs this file; false when a module imports it (the test does), so importing runs nothing: no git, no
 * exit. Node runs the real path of its entry script (unless --preserve-symlinks-main) while argv keeps the path as
 * given, so a run through a symlinked or junction path compares real paths. Otherwise the scan would silently pass.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  return Boolean(entry) && [entry, realPath(entry)].some((path) => pathToFileURL(path).href === import.meta.url);
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(`public repo scan failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}

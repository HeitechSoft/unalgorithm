# Building the Firefox add-on from its sources

For Firefox Add-ons reviewers. `unalgorithm-<version>-sources.zip` holds everything the Firefox build of unAlgorithm
Feed is made from: the extension (`apps/extension`), the workspace packages it bundles (`packages/`), the lockfile and
the workspace files. Built as below, it gives the submitted `unalgorithm-<version>-firefox.zip` file for file and byte
for byte. Our CI and release check this on every change, and that the zip holds only files committed to the
repository, nothing a local build or test run left behind (`scripts/check-firefox-sources.mjs` in the repository).

## What you need

- Node.js 22, version 22.12 or later: the release builds with Node 22 (`.nvmrc`), and `package.json` asks for 22.12 or
  later.
- pnpm 10.34.6, as `packageManager` in `package.json` says. Corepack, which comes with Node.js 22, installs that exact
  version: run `corepack enable` once (it may need an administrator shell where Node.js is installed for every user).
  `npm install -g pnpm@10.34.6` works too.
- Linux, macOS or Windows. Nothing else: no global packages. Only the install goes to the network.

## Build

From the folder the zip unpacks to:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @unalgorithm/extension exec wxt build -b firefox
```

The add-on is then in `apps/extension/.output/firefox-mv3`. Compare it with the submitted zip unpacked, for example
`diff -r apps/extension/.output/firefox-mv3 <unpacked zip>`.

If the submitted zip's `manifest.json` lists the `identity` permission, that version has sign-in to an unAlgorithm
server. Build it with that switch on:

```sh
UA_CLOUD=1 pnpm --filter @unalgorithm/extension exec wxt build -b firefox
```

On Windows, in PowerShell: `$env:UA_CLOUD = "1"`, then the same command without `UA_CLOUD=1`.

If the submitted manifest's add-on id (`browser_specific_settings.gecko.id`) is `feed-dev@unalgorithmfeed.com`, it is
the unlisted sideload build: the same bundle with the development add-on id. Build it with `UA_SIDELOAD=1` as well
(and `UA_CLOUD=1` when it lists `identity`); it is then in `apps/extension/.output/firefox-mv3-sideload`.

## What is bundled

WXT and Vite bundle and minify the TypeScript and React sources in `apps/extension/src` and `packages/*/src` into
`background.js`, the two content scripts and the pages' chunks. The open-source packages from npm, at the lockfile's
versions, are listed with their licences in `THIRD_PARTY_NOTICES.md`, which is also in the add-on. Nothing is
obfuscated, and the add-on loads no code from the network.

## The linter's warnings

`web-ext lint` (the checks AMO runs on upload) reports no errors and no notices for this build, and only warnings of
these two kinds, each from a bundled open-source library. Our CI fails on any other.

- **`DANGEROUS_EVAL`, "The Function constructor is eval"** in `background.js`, the content scripts and a page chunk:
  zod, the schema library, contains a check whether `new Function` is allowed and a fast parser compiler that uses it.
  The add-on turns both off: `apps/extension/src/lib/zod-jitless.ts` sets zod's `jitless` option, and the build
  imports it ahead of everything else in every entry point (the `unalgorithm:zod-jitless` plugin in
  `apps/extension/wxt.config.ts`). With `jitless`, zod neither runs the check nor compiles anything, so no code is
  ever made from a string.
- **`UNSAFE_VAR_ASSIGNMENT`, "Unsafe assignment to innerHTML"** in the content scripts and a page chunk: react-dom's
  code for `dangerouslySetInnerHTML` and for SVG. The add-on never uses `dangerouslySetInnerHTML`; React renders
  every text it shows as text.

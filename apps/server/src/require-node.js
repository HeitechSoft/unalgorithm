/**
 * Preloaded by the server's scripts (`node --import ./src/require-node.js src/index.ts`) and written in plain
 * JavaScript on purpose: the server runs its TypeScript source with Node.js's built-in type stripping, and a Node.js
 * without it would otherwise stop at the first `.ts` file with an unknown-extension error that names no cause.
 */
if (!process.features.typescript) {
  console.error(
    `This server needs Node.js 22.18 or newer, which runs TypeScript files directly. This Node.js (${process.versions.node}) cannot run them.`,
  );
  process.exit(1);
}

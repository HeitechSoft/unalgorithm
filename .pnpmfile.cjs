// pnpm resolves optional peers from the workspace root's devDependencies, which pulls them into the server's production
// tree. Two such peers are dropped here:
// - better-auth's vitest pulled in vitest, vite and lightningcss (MPL-2.0). The server never uses better-auth's test
//   helpers.
// - cosmiconfig's (graphile-worker's) typescript pulled the TypeScript compiler into the server image. cosmiconfig needs
//   it only to load a graphile-worker config file written in TypeScript, and the server has no config file.
const DROPPED_PEERS = new Map([
  ['better-auth', 'vitest'],
  ['cosmiconfig', 'typescript'],
]);

module.exports = {
  hooks: {
    readPackage(pkg) {
      const peer = DROPPED_PEERS.get(pkg.name);
      if (peer) {
        if (pkg.peerDependencies) delete pkg.peerDependencies[peer];
        if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[peer];
      }
      return pkg;
    },
  },
};

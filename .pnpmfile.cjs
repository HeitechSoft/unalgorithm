// better-auth declares vitest as an optional peer, and pnpm resolves optional peers from the workspace root's
// devDependencies. That pulled vitest, vite and lightningcss (MPL-2.0) into the server's production tree. The
// server never uses better-auth's test helpers, so drop the peer.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'better-auth') {
        if (pkg.peerDependencies) delete pkg.peerDependencies.vitest;
        if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.vitest;
      }
      return pkg;
    },
  },
};

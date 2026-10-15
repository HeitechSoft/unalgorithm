# The UnAlgorithm Feed server image: the server's TypeScript source, run by Node.js's built-in type stripping, with the
# sign-in page (apps/web) built in. Self-hosters and HeitechSoft run this same image (ADR 0007).
#
#   docker build -f apps/server/Dockerfile .          from the repository root (.dockerignore keeps .env files out)
#   docker compose -f apps/server/compose.yaml up -d  with the server and Postgres
#
# Workspace packages stay symlinks to /app/packages/* outside node_modules, which is what lets Node strip their types:
# Node refuses to strip types under node_modules, so `pnpm deploy`, which copies them there, is not used.

# 1. Install everything the server and the sign-in page need, and build the page.
FROM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# The manifests first, so the install layer is reused until a dependency changes. pnpm checks the lockfile against
# every workspace package and against the pnpmfile hook that keeps vitest out of the server's tree.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs ./
COPY apps/extension/package.json apps/extension/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/ai/package.json packages/ai/
COPY packages/core/package.json packages/core/
COPY packages/outlets/package.json packages/outlets/
COPY packages/platforms/package.json packages/platforms/
COPY packages/protocol/package.json packages/protocol/
COPY packages/research/package.json packages/research/
COPY packages/sync/package.json packages/sync/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile --filter @unalgorithm/server... --filter @unalgorithm/web...
COPY tsconfig.base.json ./
COPY packages/ packages/
# The outlet registry's build gate (P3-27): the image is never built with an unreviewed label or a bad signature.
RUN node packages/outlets/src/cli.ts check
COPY apps/server/ apps/server/
COPY apps/web/ apps/web/
RUN pnpm --filter @unalgorithm/web build

# 2. The production tree: the server's runtime dependencies, its source and migrations, and the built page.
FROM node:24-bookworm-slim AS prod
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .pnpmfile.cjs ./
COPY apps/extension/package.json apps/extension/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/ai/package.json packages/ai/
COPY packages/core/package.json packages/core/
COPY packages/outlets/package.json packages/outlets/
COPY packages/platforms/package.json packages/platforms/
COPY packages/protocol/package.json packages/protocol/
COPY packages/research/package.json packages/research/
COPY packages/sync/package.json packages/sync/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile --prod --filter @unalgorithm/server...
COPY packages/protocol/src packages/protocol/src
COPY packages/core/src packages/core/src
COPY packages/sync/src packages/sync/src
COPY packages/ai/src packages/ai/src
# route-eval imports @unalgorithm/ai/eval: the Cloud opens its eval gate inside the container.
COPY packages/ai/eval packages/ai/eval
COPY packages/research/src packages/research/src
# Perspectives reads the bundled registry: bundledRegistry() imports data/registry.json, so the server needs both.
COPY packages/outlets/src packages/outlets/src
COPY packages/outlets/data packages/outlets/data
# route-eval scores the research and synthesis routes with @unalgorithm/research/eval (P3-17).
COPY packages/research/eval packages/research/eval
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
COPY --from=build /repo/apps/web/dist apps/web/dist
COPY LICENSE ./

# 3. The runtime: the production tree only, owned by root and run as `node`, so the server cannot change its own code.
FROM node:24-bookworm-slim AS runtime
ARG VERSION=dev
LABEL org.opencontainers.image.title="UnAlgorithm Feed server" \
      org.opencontainers.image.source="https://github.com/HeitechSoft/unalgorithm" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="$VERSION"
# COPY keeps pnpm's symlinks.
COPY --from=prod /repo /app
# The command-line tools run from here too: `docker compose exec server node apps/server/src/cli/route-eval.ts`.
WORKDIR /app
# HOST applies inside the container only; compose.yaml decides what is published, on 127.0.0.1 by default.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 WEB_DIST=/app/apps/web/dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/index.ts"]

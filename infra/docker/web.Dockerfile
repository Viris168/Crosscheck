# syntax=docker/dockerfile:1
# The only app image: Next.js app (UI + REST API + Inngest endpoint) and the `migrate` one-shot.
#
#   docker build -f infra/docker/web.Dockerfile -t ai-review-web .     # context = repo root
#
# Stages: pruner (turbo prune) → builder (pnpm install + turbo build) → runner (slim, non-root).
# Works with or without `output: 'standalone'` in apps/web/next.config.ts:
#   - standalone present  → runs apps/web/server.js from the traced output (small image)
#   - standalone missing  → runs `next start` from the pruned workspace (bigger image)
# See tasks/CONTRACT_REQUESTS.md → "[Lane G] Next.js output: 'standalone'".

ARG NODE_VERSION=22
ARG PNPM_VERSION=11.21.0
ARG TURBO_VERSION=2.11.11
# Debian release for every stage. trixie (13) because the runner needs git >= 2.44 (GIT_NO_LAZY_FETCH,
# see tasks/T-branch-tree.md → Privacy rules) and trixie ships 2.47 natively. bookworm ships 2.39 and
# bookworm-backports has no newer git; pulling trixie's git into bookworm would also replace libc6 and
# libssl, so the whole image moves to trixie instead (builder too, so native modules and the Prisma
# engine are built against the same libc/openssl they run on).
ARG DEBIAN_RELEASE=trixie

# ---------------------------------------------------------------- base
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
# openssl: Prisma query engine (debian-openssl-3.0.x)
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "pnpm@${PNPM_VERSION}" \
 && npm cache clean --force
WORKDIR /repo

# ---------------------------------------------------------------- pruner
FROM base AS pruner
ARG TURBO_VERSION
COPY . .
RUN npx -y "turbo@${TURBO_VERSION}" prune @app/web --docker

# ---------------------------------------------------------------- builder
FROM base AS builder
# 1) dependencies only (cached until a package.json / the lockfile changes)
COPY --from=pruner /repo/out/json/ .
# @app/db runs `prisma generate` on postinstall → it needs the schema before install.
COPY --from=pruner /repo/out/full/packages/db/prisma ./packages/db/prisma
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --fetch-timeout=600000 --fetch-retries=5 --network-concurrency=8
# 2) sources + build. No secrets at build time: env is validated at runtime (src/server/env.ts).
COPY --from=pruner /repo/out/full/ .
# turbo prune leaves out root config the workspace packages extend.
COPY --from=pruner /repo/tsconfig.base.json ./
RUN SKIP_ENV_VALIDATION=1 pnpm turbo build --filter @app/web
# 3) prisma CLI (same version as @app/db) for the `migrate` service, outside the app tree
RUN PRISMA_VERSION="$(node -p "require('./packages/db/node_modules/prisma/package.json').version")" \
 && mkdir -p /opt/prisma \
 && cd /opt/prisma \
 && npm init -y >/dev/null \
 && npm install --no-audit --no-fund "prisma@${PRISMA_VERSION}" \
 && npm cache clean --force
# 4) assemble the runtime tree in /out
RUN set -eu; \
    mkdir -p /out/prisma; \
    cp -a packages/db/prisma/schema.prisma packages/db/prisma/migrations /out/prisma/; \
    if [ -f apps/web/.next/standalone/apps/web/server.js ]; then \
      echo "web: using Next.js standalone output"; \
      cp -a apps/web/.next/standalone/. /out/; \
      cp -a apps/web/.next/static /out/apps/web/.next/static; \
      if [ -d apps/web/public ]; then cp -a apps/web/public /out/apps/web/public; fi; \
      printf '#!/bin/sh\ncd /app/apps/web\nexec node server.js\n' > /out/start.sh; \
    else \
      echo "web: no standalone output, falling back to next start (see tasks/CONTRACT_REQUESTS.md)"; \
      cp -a /repo/. /out/; \
      rm -rf /out/apps/web/.next/cache; \
      printf '#!/bin/sh\ncd /app/apps/web\nexec node node_modules/next/dist/bin/next start -H "${HOSTNAME:-0.0.0.0}" -p "${PORT:-3000}"\n' > /out/start.sh; \
    fi; \
    chmod 0755 /out/start.sh; \
    mkdir -p /out/apps/web/.next/cache

# ---------------------------------------------------------------- runner
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
# git: commits-only clone cache for the branch tree (`git clone --bare --filter=tree:0`), >= 2.44.
# The smoke step fails the build if the installed git is older.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && git --version \
 && git --version | awk '{ split($3, v, "."); if (v[1] < 2 || (v[1] == 2 && v[2] < 44)) { print "git >= 2.44 required"; exit 1 } }'
WORKDIR /app
# App files are owned by root (read-only for the app user); only the Next cache is writable.
COPY --from=builder /out/ /app/
COPY --from=builder /opt/prisma /opt/prisma
# Repo clone cache (REPO_CACHE_DIR). Created here owned by `node` so a fresh named volume mounted on it
# (infra/compose.prod.yml → repo-cache) inherits that ownership.
ENV REPO_CACHE_DIR=/var/lib/app/repos
RUN chown -R node:node /app/apps/web/.next/cache \
 && mkdir -p /var/lib/app/repos \
 && chown node:node /var/lib/app/repos \
 && chmod 0700 /var/lib/app/repos
# `node` (uid 1000) is the non-root user shipped with the official image.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["/app/start.sh"]

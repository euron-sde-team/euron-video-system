# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Control plane + playback API.
#   docker build -f infra/docker/api.Dockerfile -t evs-api .
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @evs/api... --filter euron-video-system
COPY tsconfig.base.json tsconfig.json ./
COPY packages/core packages/core
COPY apps/api apps/api
COPY db db
COPY scripts scripts
RUN pnpm --filter @evs/api build

# ─── tools: migrations + the evs CLI (used by the compose `migrate` one-shot) ─
FROM build AS tools
ENV TZ=UTC
# Runs as root on purpose: a short-lived one-shot that only reads the repo.
CMD ["pnpm", "db:migrate"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production TZ=UTC EVS_SERVICE=api PORT=8080
WORKDIR /app
# tini reaps zombies and forwards SIGTERM so the cluster drains connections.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Self-contained single-file bundle: no node_modules at runtime.
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

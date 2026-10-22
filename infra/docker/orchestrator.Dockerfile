# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Orchestrator as a long-running loop (local / non-Lambda deployments).
# On AWS the same code runs as a scheduled Lambda (dist/lambda/index.js).
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/orchestrator/package.json apps/orchestrator/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @evs/orchestrator...
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/orchestrator apps/orchestrator
RUN pnpm --filter @evs/orchestrator build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production TZ=UTC EVS_SERVICE=orchestrator LAUNCHER=noop
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Self-contained single-file bundle: no node_modules at runtime.
COPY --from=build --chown=node:node /repo/apps/orchestrator/dist ./dist
USER node
# No HTTP surface: a crashed loop exits non-zero and the restart policy
# (compose `restart: unless-stopped`, ECS/systemd) brings it back.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/local.js"]

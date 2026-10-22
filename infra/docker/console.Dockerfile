# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Operator console: static Vite build served by unprivileged nginx (port 8080).
# The API base URL is entered in the console's Settings screen, so one image
# works against any deployment.
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/console/package.json apps/console/
COPY packages/player/package.json packages/player/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @evs/console...
COPY tsconfig.base.json ./
COPY packages/player packages/player
COPY apps/console apps/console
ARG VITE_API_BASE=http://localhost:8080
ENV VITE_API_BASE=${VITE_API_BASE}
RUN pnpm --filter @evs/console build

FROM nginxinc/nginx-unprivileged:1.31-alpine AS runtime
COPY infra/docker/console.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/console/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1

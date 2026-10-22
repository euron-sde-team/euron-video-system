# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Transcode worker: FFmpeg + whisper.cpp + the worker bundle. Multi-arch.
#
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f infra/docker/worker.Dockerfile -t evs-worker .
#
# Slim image without captions (no whisper build, no model download, ~400 MB smaller):
#   docker build -f infra/docker/worker.Dockerfile --build-arg CAPTIONS=false -t evs-worker:slim .
#
# Model size trades accuracy for speed: tiny | base | small (default) | medium.
# ─────────────────────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22.23.4-bookworm-slim
ARG WHISPER_VERSION=v1.9.5
ARG WHISPER_MODEL=small
ARG CAPTIONS=true
# Static FFmpeg build (libx264, libx265, native AAC, HLS muxer), multi-arch. Two
# binaries instead of Debian's ffmpeg package, which hard-depends on ~250
# desktop/GPU libraries (Vulkan, libplacebo, LV2...) a headless transcoder never uses.
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:7.1.1

FROM ${FFMPEG_IMAGE} AS ffmpeg

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# ─── whisper.cpp (built from a pinned release tag) ───────────────────────────
# GGML_NATIVE=OFF: portable baseline ISA, so one image runs on every CPU of its
# architecture (and builds under emulation / inside VMs).
FROM debian:bookworm-slim AS whisper
ARG WHISPER_VERSION
ARG WHISPER_MODEL
ARG CAPTIONS
RUN mkdir -p /opt/whisper.cpp /opt/models && if [ "$CAPTIONS" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake git ca-certificates curl \
   && git clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp /src \
   && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE=OFF \
   && cmake --build /src/build -j"$(nproc)" --target whisper-cli \
   && cp /src/build/bin/whisper-cli /opt/whisper.cpp/whisper-cli; \
    fi
# The model (~466 MB for "small") is its own layer: an interrupted or retried
# download never invalidates the cached compile above. --retry rides out
# transient CDN errors instead of failing the whole build.
RUN if [ "$CAPTIONS" = "true" ]; then \
      curl -fsSL --retry 5 --retry-delay 3 -o "/opt/models/ggml-${WHISPER_MODEL}.bin" \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin"; \
    fi

# ─── worker bundle ───────────────────────────────────────────────────────────
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @evs/worker...
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/worker apps/worker
RUN pnpm --filter @evs/worker build

FROM ${NODE_IMAGE} AS runtime
ARG WHISPER_MODEL
ENV NODE_ENV=production TZ=UTC EVS_SERVICE=worker \
    WORKER_PLATFORM=local WORK_DIR=/work \
    FFMPEG_BIN=/usr/local/bin/ffmpeg FFPROBE_BIN=/usr/local/bin/ffprobe \
    WHISPER_BIN=/opt/whisper.cpp/whisper-cli \
    WHISPER_MODEL=/opt/models/ggml-${WHISPER_MODEL}.bin
# libgomp1: OpenMP runtime whisper.cpp links against (Debian's ffmpeg package used
# to pull it in transitively; with a static FFmpeg it must be explicit).
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /work && chown node:node /work
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=whisper /opt/whisper.cpp /opt/whisper.cpp
COPY --from=whisper /opt/models /opt/models
WORKDIR /app
# Self-contained single-file bundle: no node_modules at runtime.
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
USER node
VOLUME ["/work"]
# The worker has no HTTP surface; liveness = the process is up and its
# scratch directory is writable.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD test -w /work || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

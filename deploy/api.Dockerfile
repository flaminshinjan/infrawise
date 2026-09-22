# API/orchestrator image: Node + adb (for TCP-attached devices) + ffmpeg (stream transcode)
FROM node:22-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends adb ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/device-adapter/package.json packages/device-adapter/
RUN pnpm install --frozen-lockfile --filter "@lab/server..."

COPY apps/server apps/server
COPY packages packages

EXPOSE 4000
CMD ["pnpm", "--filter", "@lab/server", "start"]

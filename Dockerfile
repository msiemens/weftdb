# syntax=docker/dockerfile:1
#
# The relay server. The build stage bundles the workspace into one file (vite.config.ts), so
# the runtime stage carries no package manager, no node_modules and no source tree — just
# Node and dist/server.mjs, on a distroless base that runs as a non-root user with no shell.

FROM node:22-bookworm-slim AS build
WORKDIR /src
ENV CI=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json vite.config.ts ./
RUN pnpm build:server
# Distroless has no shell to mkdir with at runtime, so the data directory is created here and
# copied in with the right ownership.
RUN mkdir -p /data-template

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=build /src/dist ./
COPY --from=build --chown=65532:65532 /data-template /data

# The relay persists by default: a sync server that forgets its scope on restart would hand
# every device a resync and lose anything not yet pushed. Mount a volume at /data to keep it
# outside the container; set WEFT_DB= (empty) for a deliberately ephemeral instance.
#
# WEFT_TOKENS is required and has no default: a relay that cannot authenticate anyone
# refuses to start rather than coming up and rejecting every request.
ENV NODE_ENV=production \
    WEFT_HOST=0.0.0.0 \
    WEFT_PORT=8787 \
    WEFT_DB=/data/weft.sqlite
VOLUME ["/data"]
EXPOSE 8787
USER nonroot

HEALTHCHECK --interval=30s --timeout=3s --start-period=2s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch(`http://127.0.0.1:${process.env.WEFT_PORT ?? 8787}/health`).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# node:sqlite is behind a flag on Node 22; drop it if the base image moves to a release where
# it is unflagged.
CMD ["--experimental-sqlite", "/app/server.mjs"]

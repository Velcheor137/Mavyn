# syntax=docker/dockerfile:1
# Multi-stage build: web assets (Node) + API server (Rust) → small Debian runtime.
# Build from the repository root:
#   docker build -f infrastructure/docker/server.Dockerfile -t mavyn:local .

FROM node:22-bookworm AS web
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/desktop/package.json ./apps/desktop/package.json
RUN npm ci --no-audit --no-fund
ENV NODE_OPTIONS=--max-old-space-size=2560
RUN npm run build -w @mdr/web

FROM rust:1.95-bookworm AS server
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps/server ./apps/server
COPY infrastructure/migrations ./infrastructure/migrations
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p mdr-server && cp target/release/mdr-server /usr/local/bin/mdr-server

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /app mdr
WORKDIR /app
COPY --from=server /usr/local/bin/mdr-server /usr/local/bin/mdr-server
COPY --from=web /src/apps/web/dist /app/web
ENV BIND_ADDR=0.0.0.0:8080 WEB_DIST=/app/web RUST_LOG=info
USER mdr
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/api/v1/health || exit 1
ENTRYPOINT ["/usr/local/bin/mdr-server"]

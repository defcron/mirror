# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build

FROM rustlang/rust:nightly-bookworm AS rust-build

WORKDIR /app
ENV CARGO_BUILD_JOBS=1 CMAKE_BUILD_PARALLEL_LEVEL=1
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang && rm -rf /var/lib/apt/lists/*
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --locked --release --bin mirror-server && \
    mkdir -p /build-artifacts && cp /app/target/release/mirror-server /build-artifacts/mirror-server
# devDependencies stay in the image below rather than being pruned or
# reinstalled fresh - both npm prune --omit=dev (bulk-delete) and a second
# `npm ci --omit=dev` (bulk-write) hang for a very long time on this
# machine's Colima setup, apparently regardless of which direction the
# many-small-files I/O goes. Simplest reliable fix: just keep the one
# node_modules the build stage already produced, dev packages and all.
# Bigger runtime image, but it actually finishes building.

FROM node:24-bookworm-slim AS runtime

ARG MIRROR_BUILD_REVISION=development
LABEL org.opencontainers.image.revision=$MIRROR_BUILD_REVISION
ENV MIRROR_BUILD_REVISION=$MIRROR_BUILD_REVISION

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    MIRROR_DATA_DIR=/home/node/.mirror \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY scripts/storage.mjs scripts/restore-drill.mjs ./scripts/
COPY --from=rust-build /build-artifacts/mirror-server /usr/local/bin/mirror-server
RUN mkdir -p /home/node/.mirror && chown node:node /home/node/.mirror
USER node
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/mirror-server"]

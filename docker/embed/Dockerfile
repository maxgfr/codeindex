# syntax=docker/dockerfile:1
#
# codeindex rich-tier embedding server image (ghcr.io/maxgfr/codeindex-embed).
# Role B of the Docker plan: a minimal HTTP server that serves all-MiniLM-L6-v2
# so the engine (CODEINDEX_EMBED_ENDPOINT) can fetch float embeddings. The engine
# itself stays zero-dependency — these deps live ONLY in this image.
#
# Two stages:
#   build — npm install (wasm ONNX runtime; native onnxruntime-node/sharp omitted
#           so the image is portable across amd64/arm64) + warm.mjs, which
#           downloads and BAKES the model into /build/models.
#   run   — node:22-slim + node_modules + the baked model + server.mjs, non-root,
#           fully offline (no network at run time), listening on :8756.

# ---- build stage: install deps and bake the model -------------------------
FROM node:22-slim AS build
WORKDIR /build

# transformers.js statically imports onnxruntime-node, so we pin it explicitly as
# a real dependency (it ships prebuilt linux x64/arm64 binaries — no compiler
# needed on slim, and buildx installs the right one per arch). --omit=optional
# only skips packages reachable exclusively via an optional edge (upstream's own
# optional onnxruntime-node, already pinned above as required regardless) — it
# does NOT drop `sharp`: sharp is a REGULAR dependency of @xenova/transformers,
# required on the feature-extraction path (see the prune step below), so it
# always installs.
COPY package.json ./
RUN npm install --omit=optional --no-audit --no-fund

# Download + cache the model at build time (baked into the layer below).
ENV MODEL_CACHE_DIR=/build/models
COPY warm.mjs server.mjs ./
RUN node warm.mjs

# Trim dead weight: in Node, transformers.js selects the native onnxruntime-node
# CPU backend; onnxruntime-web is only statically imported (its JS must resolve),
# but its wasm binaries are never instantiated here — so drop them. (sharp is
# kept: it is statically imported on the feature-extraction path.) The e2e below
# re-verifies /embed after this prune.
RUN rm -f node_modules/onnxruntime-web/dist/*.wasm

# ---- run stage: slim, offline, non-root -----------------------------------
FROM node:22-slim AS run
ARG VERSION=dev

LABEL org.opencontainers.image.source="https://github.com/maxgfr/codeindex" \
      org.opencontainers.image.description="codeindex rich-tier embedding server: all-MiniLM-L6-v2 (transformers.js), POST /embed + GET /healthz, model baked in." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app

# Copy the installed deps, the baked model and the server. Nothing is fetched at
# run time — the offline env vars below make transformers.js read only the cache.
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/models ./models
COPY server.mjs package.json ./

ENV NODE_ENV=production \
    MODEL_CACHE_DIR=/app/models \
    PORT=8756 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_OFFLINE=1

# Drop root — the server only reads its own files and listens on a port.
USER node

EXPOSE 8756

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8756)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/server.mjs"]

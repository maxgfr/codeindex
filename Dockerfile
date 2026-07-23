# syntax=docker/dockerfile:1
#
# codeindex distribution image — a thin wrapper around the already-built,
# zero-runtime-dependency bundle. `pnpm build` produces scripts/engine.mjs +
# scripts/engine.d.mts (tsup + postbuild) and both are committed to the repo,
# so there is nothing to `npm install` or compile here: the image is just
# `node` plus that bundle, its thin CLI entry, and the optional tree-sitter
# grammars that turn on the AST extraction tier. No src/, no node_modules, no
# embedding model (those are opt-in and stay outside the image — see
# docs/SEMANTIC.md / `codeindex embed pull`).
#
# Base: node:22-slim (Debian bookworm). A distroless nodejs22 base is ~27 MiB
# smaller, but node:22-slim already lands the full image comfortably under
# the 200 MiB target once the ~22 MiB of grammars are added, and it keeps a
# shell + coreutils in the image for support/debugging (`docker run --rm -it
# --entrypoint sh ghcr.io/maxgfr/codeindex`) at negligible cost — worth more
# here than the extra size shaved off an already-small image.
FROM node:22-slim

ARG VERSION=dev

LABEL org.opencontainers.image.source="https://github.com/maxgfr/codeindex" \
      org.opencontainers.image.description="Self-contained, deterministic repo-indexing engine (zero runtime deps): walk, symbols, typed link-graph, SCIP index, MCP server." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app

# Bundle + thin CLI entry.
COPY --chown=node:node scripts/engine.mjs scripts/engine.d.mts scripts/cli.mjs ./scripts/
# AST tier: tree-sitter grammars must sit next to engine.mjs (scripts/grammars)
# for the loader's same-directory resolution to find them — see
# resolveGrammarDir() in engine.mjs.
COPY --chown=node:node scripts/grammars ./scripts/grammars
COPY --chown=node:node package.json README.md LICENSE ./
COPY --chown=node:node docs/MIGRATION.md ./docs/MIGRATION.md

# Drop root: the image only ever reads its own files and the bind-mounted
# repo under /work, never writes inside /app.
USER node

# The repo to index is bind-mounted here at run time:
#   docker run --rm -v $PWD:/work ghcr.io/maxgfr/codeindex scan --repo /work
WORKDIR /work

ENTRYPOINT ["node", "/app/scripts/cli.mjs"]
CMD ["--help"]

# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

## [2.28.3](https://github.com/maxgfr/codeindex/compare/v2.28.2...v2.28.3) (2026-09-03)


### Bug Fixes

* validate the .git marker, and stop serving stale traversal caches ([#17](https://github.com/maxgfr/codeindex/issues/17)) ([9ff08f6](https://github.com/maxgfr/codeindex/commit/9ff08f641059396557f82e121e67301097e00bd2)), closes [#16](https://github.com/maxgfr/codeindex/issues/16)

## [2.28.2](https://github.com/maxgfr/codeindex/compare/v2.28.1...v2.28.2) (2026-09-02)


### Performance Improvements

* walker boundaries, batched worker dispatch, hot-path memos ([#16](https://github.com/maxgfr/codeindex/issues/16)) ([39aa752](https://github.com/maxgfr/codeindex/commit/39aa7524b55196e547b436c0a50ee7eca25ec146))

## [2.28.1](https://github.com/maxgfr/codeindex/compare/v2.28.0...v2.28.1) (2026-08-31)


### Bug Fixes

* harden runtime and accelerate indexing ([#15](https://github.com/maxgfr/codeindex/issues/15)) ([bea4af3](https://github.com/maxgfr/codeindex/commit/bea4af3493d629438a586d2329d40ae5f68b638f))

# [2.28.0](https://github.com/maxgfr/codeindex/compare/v2.27.1...v2.28.0) (2026-08-12)


### Bug Fixes

* **bench:** the repo cloner is clonePinned, not ensureRepo ([f4eab99](https://github.com/maxgfr/codeindex/commit/f4eab995505ed22e56b4462467cb776440ba03e7))
* **search:** index the right tree, and say when a query found nothing ([df2c9c3](https://github.com/maxgfr/codeindex/commit/df2c9c3b428f97711ea90bd5f1763301f230380e))


### Features

* **bench:** grade answer quality against the TypeScript compiler ([a2d8521](https://github.com/maxgfr/codeindex/commit/a2d852167ca77dbb24043be00b6056211f8d1e36))
* **bench:** run the answer-quality benchmark, and report what it says ([612870b](https://github.com/maxgfr/codeindex/commit/612870bf649dead00eecd7c1f41c3b080f81d71e))
* **lsp:** opt-in language-server tier for type-aware references ([a70ca0d](https://github.com/maxgfr/codeindex/commit/a70ca0d0f9895e1b378832ea2ab793c9a2d19428))
* **mcp:** tool profiles and a one-call project brief ([f73df3a](https://github.com/maxgfr/codeindex/commit/f73df3ac899bc7c0e0f5dd288f497fb568385e90))
* **query:** let the caller choose the payload, and score the row we were losing ([8f716a8](https://github.com/maxgfr/codeindex/commit/8f716a8247179c4a6581bf87417ac24a403f920c))

## [2.27.1](https://github.com/maxgfr/codeindex/compare/v2.27.0...v2.27.1) (2026-08-05)


### Bug Fixes

* **literals:** stop reporting vocabulary and coincidence as duplication ([3aed123](https://github.com/maxgfr/codeindex/commit/3aed123e2d5ae4c22340a33388552975b63ea4e9))

# [2.27.0](https://github.com/maxgfr/codeindex/compare/v2.26.0...v2.27.0) (2026-08-05)


### Bug Fixes

* **classify:** index terraform, solidity, zig and hcl in real scans ([0784eeb](https://github.com/maxgfr/codeindex/commit/0784eeb65cde52fbeacb4a9a70b5938926493a49))


### Features

* **literals:** report values with no single source of truth ([ac410b7](https://github.com/maxgfr/codeindex/commit/ac410b7c6aa4548d9e423ef675d9b5ce878b0bf0))

# [2.26.0](https://github.com/maxgfr/codeindex/compare/v2.25.2...v2.26.0) (2026-08-01)


### Features

* **playground:** open a local folder, and survive a rough network ([5249efb](https://github.com/maxgfr/codeindex/commit/5249efba621a83bce46d512b3ae3355c93e83f13))

## [2.25.2](https://github.com/maxgfr/codeindex/compare/v2.25.1...v2.25.2) (2026-08-01)


### Bug Fixes

* **playground:** stop a rate-limited load from freezing on a stale counter ([53ce749](https://github.com/maxgfr/codeindex/commit/53ce749219960965f5c28661bbc363ca4bee26bd))

## [2.25.1](https://github.com/maxgfr/codeindex/compare/v2.25.0...v2.25.1) (2026-08-01)


### Bug Fixes

* **playground:** repair the header wordmark, the card padding, and the palette ([fa549e9](https://github.com/maxgfr/codeindex/commit/fa549e98cfe45de45683dbd98d6ba2f0ead5c1b0))

# [2.25.0](https://github.com/maxgfr/codeindex/compare/v2.24.2...v2.25.0) (2026-08-01)


### Features

* **playground:** index everything by default, and adopt the site's design ([972ab68](https://github.com/maxgfr/codeindex/commit/972ab68fccbcb9d76c2d56a42e83840e34414443))

## [2.24.2](https://github.com/maxgfr/codeindex/compare/v2.24.1...v2.24.2) (2026-08-01)


### Bug Fixes

* **playground:** anchor the palette to the input, and stop claiming jsDelivr ([7c175e0](https://github.com/maxgfr/codeindex/commit/7c175e068c1631369bcd8f7b063e16d050b47644))
* **site:** deploy the playground after a release, not one release later ([8fb0260](https://github.com/maxgfr/codeindex/commit/8fb0260266509ff807d2208af51a841c597629ed))

## [2.24.1](https://github.com/maxgfr/codeindex/compare/v2.24.0...v2.24.1) (2026-08-01)


### Bug Fixes

* **site:** redeploy the playground when the engine bundle changes ([6f486fe](https://github.com/maxgfr/codeindex/commit/6f486fe50059008e34d7b3cf86bf89e97a4db991))

# [2.24.0](https://github.com/maxgfr/codeindex/compare/v2.23.0...v2.24.0) (2026-08-01)


### Features

* **browser:** publish the browser build as @maxgfr/codeindex/browser ([5a9b8fb](https://github.com/maxgfr/codeindex/commit/5a9b8fb2f7b6a7efa9f07db49f9705b80b0be2c7))

# [2.23.0](https://github.com/maxgfr/codeindex/compare/v2.22.1...v2.23.0) (2026-08-01)


### Features

* **playground:** run the engine in the browser, on a public repo ([#13](https://github.com/maxgfr/codeindex/issues/13)) ([6cd2dec](https://github.com/maxgfr/codeindex/commit/6cd2dec0ef249df28f982b47000d95497c0c8179))

## [2.22.1](https://github.com/maxgfr/codeindex/compare/v2.22.0...v2.22.1) (2026-07-31)


### Bug Fixes

* **extract:** index declarations inside an IIFE, and module constants on the regex tier ([891f7fb](https://github.com/maxgfr/codeindex/commit/891f7fb5378aa5174bc9db698eeeb4d473369a06))

# [2.22.0](https://github.com/maxgfr/codeindex/compare/v2.21.1...v2.22.0) (2026-07-30)


### Features

* **ast:** close the three recall gaps the ctags differential named ([dea75aa](https://github.com/maxgfr/codeindex/commit/dea75aad445634bc590e3ce148e06673c512a92b))

## [2.21.1](https://github.com/maxgfr/codeindex/compare/v2.21.0...v2.21.1) (2026-07-30)


### Bug Fixes

* **grammars:** ship tags.scm in the pull asset, and surface query status ([dab65b7](https://github.com/maxgfr/codeindex/commit/dab65b708e512865a9cfd70cfe148b99bff1162c))

# [2.21.0](https://github.com/maxgfr/codeindex/compare/v2.20.1...v2.21.0) (2026-07-30)


### Features

* **ast:** audit against each grammar's own tags.scm, and index record components ([bb4c52a](https://github.com/maxgfr/codeindex/commit/bb4c52aae1b0905f016d4db0bdd3011a90ca9859))
* **ast:** index type members, qualify parents, attach docs and full signatures ([1f764fa](https://github.com/maxgfr/codeindex/commit/1f764fac62a00f5cff05d100798998b35180d229))
* **grammars:** add a pull-only extended tier — Kotlin, Elixir, Zig, Solidity, HCL ([e70fcea](https://github.com/maxgfr/codeindex/commit/e70fceab1d9525d1cb5ef6aa8ba9619acfc20195))
* **graph:** resolve inheritance into edges, a type hierarchy and a symbol graph ([35fced5](https://github.com/maxgfr/codeindex/commit/35fced5fb3bca22abe187ac4cd93de16d4da7e3a))
* **search:** BM25F over six fields, prose indexing and a stem fallback ([2e9abf7](https://github.com/maxgfr/codeindex/commit/2e9abf7a52f74226d16c3577749adff2494ce56e))

## [2.20.1](https://github.com/maxgfr/codeindex/compare/v2.20.0...v2.20.1) (2026-07-25)


### Bug Fixes

* **bench:** correct harness comments that outlived what they described ([03c1eb4](https://github.com/maxgfr/codeindex/commit/03c1eb4bbcf1f9edee6aff1e5ee3264bfa84f599))

# [2.20.0](https://github.com/maxgfr/codeindex/compare/v2.19.1...v2.20.0) (2026-07-25)


### Features

* **walk:** stop capping at 20,000 files by default ([199bb48](https://github.com/maxgfr/codeindex/commit/199bb483ff1801742f19f54b91d0d4a078963ca2))

## [2.19.1](https://github.com/maxgfr/codeindex/compare/v2.19.0...v2.19.1) (2026-07-25)


### Bug Fixes

* **delta:** stop charging dangling risk for an import into an ignored tree ([1413198](https://github.com/maxgfr/codeindex/commit/14131980fa0bebd3f668c96f879e5bc571d27634))

# [2.19.0](https://github.com/maxgfr/codeindex/compare/v2.18.0...v2.19.0) (2026-07-25)


### Features

* **mcp:** declare outputSchema and emit structuredContent where it can conform ([443a699](https://github.com/maxgfr/codeindex/commit/443a69985a4fe8fcf3c85c5c0cf6b3118fa6658e))

# [2.18.0](https://github.com/maxgfr/codeindex/compare/v2.17.1...v2.18.0) (2026-07-25)


### Bug Fixes

* **cli:** teach the flag hoister about --workers, --index and --max-response-bytes ([315d9ca](https://github.com/maxgfr/codeindex/commit/315d9caa4eca6385ecb4b1c36064822bb501e838))
* **pool:** ask workers for the main thread's grammars, and bound a hung worker ([2fc4ec6](https://github.com/maxgfr/codeindex/commit/2fc4ec6de7e0b9dc67a0c5d433d359cf8c06c892))
* **sources:** stop shipping literal NUL bytes in TypeScript sources ([76ad826](https://github.com/maxgfr/codeindex/commit/76ad82614537f38a82195f558e018868cdbe7065))


### Features

* **graph:** delta review, impact and neighbors — the traversals consumers kept reimplementing ([08c5fd8](https://github.com/maxgfr/codeindex/commit/08c5fd8570fc64ff2e2b3faf88fe7eae2cf20453))
* **mcp:** bound oversized responses, expose the caps that already existed ([e46277a](https://github.com/maxgfr/codeindex/commit/e46277a0f11c96c699b46f5d14a8334dd6f0505b))
* **mcp:** negotiate the protocol, annotate the tools, validate the arguments ([5b686d5](https://github.com/maxgfr/codeindex/commit/5b686d5481c2a589deb396db4ec38350b81c2c91))


### Performance Improvements

* **cli:** reuse the persisted index in every read command ([9e82664](https://github.com/maxgfr/codeindex/commit/9e82664eb2a22fa5c09dec4772930abe29ecab8d))
* **extract:** fold four AST traversals into one, drop the discarded ones ([8ae58d2](https://github.com/maxgfr/codeindex/commit/8ae58d28e14ae7884da84fcbf65278bfb2cb955b))
* **mcp:** one walk per call, a bounded LRU, and a memoized caller index ([ef6353a](https://github.com/maxgfr/codeindex/commit/ef6353afe2a096190d01a299f77396ab0b89a276))
* **mcp:** skip the resource-link probe on responses that were not capped ([2ca6200](https://github.com/maxgfr/codeindex/commit/2ca6200b68e2838c82868c254dfc6131ea989f06))
* **pool:** extract across worker_threads, byte-identical to sequential ([c53258c](https://github.com/maxgfr/codeindex/commit/c53258ccf7510a44d0219b3458e403840a9ffd85))
* **scip:** assemble the protobuf into a growable Uint8Array, not a number[] ([8bbce52](https://github.com/maxgfr/codeindex/commit/8bbce52064d257cf77f210d231861b5233190e7e))

## [2.17.1](https://github.com/maxgfr/codeindex/compare/v2.17.0...v2.17.1) (2026-07-25)


### Bug Fixes

* **cli:** accept global flags before the subcommand ([75ccc7d](https://github.com/maxgfr/codeindex/commit/75ccc7d35fdb094200074bde2ad2306e30dd8f38))

# [2.17.0](https://github.com/maxgfr/codeindex/compare/v2.16.0...v2.17.0) (2026-07-25)


### Features

* **mcp:** pin one repo with --repo, add `rewrite`, fix grep --scope ([a205c34](https://github.com/maxgfr/codeindex/commit/a205c343b7ce254d8cb4eecec76442d24633da62))

# [2.16.0](https://github.com/maxgfr/codeindex/compare/v2.15.0...v2.16.0) (2026-07-24)


### Features

* **ast:** expose warmGrammars — the one-call AST warm-up consumers were missing ([af7011c](https://github.com/maxgfr/codeindex/commit/af7011c374a34bdcedf6da42fc6700c23ae5abd9))

# [2.15.0](https://github.com/maxgfr/codeindex/compare/v2.14.0...v2.15.0) (2026-07-24)


### Features

* **bench:** prime+preload codeindex MCP path for a symmetric measurement ([d1e1d92](https://github.com/maxgfr/codeindex/commit/d1e1d9294876b31615a304cbdcf07a056ef5091d))


### Performance Improvements

* **mcp:** preload the persisted .codeindex index on first tool call ([78deb48](https://github.com/maxgfr/codeindex/commit/78deb48083ceb343765be02f90ad66ccf5e037db))

# [2.14.0](https://github.com/maxgfr/codeindex/compare/v2.13.0...v2.14.0) (2026-07-24)


### Bug Fixes

* **ast:** re-derive the MCP grammar warm per call, not once per repo path ([cdef284](https://github.com/maxgfr/codeindex/commit/cdef2845b18f21fe5ed3d56af85efab4a29f0634))
* **bench:** assert non-optional section slices in the smoke test (strict typecheck) ([93538cb](https://github.com/maxgfr/codeindex/commit/93538cbb95fdd5eac75d498e784409e7fcd2a367))
* **bench:** fairness and robustness fixes from live end-to-end validation ([7d77a28](https://github.com/maxgfr/codeindex/commit/7d77a28b290d9ee5cd5001275876b48d523f427e))
* **bench:** gate serena and graphify off oversized monorepos (next.js) ([4f9bad3](https://github.com/maxgfr/codeindex/commit/4f9bad3d4d7be794c9cebb1ec8793403d00fa0d5))
* **mcp:** refresh scan_summary commit after a git HEAD move on an unchanged worktree ([e3420e5](https://github.com/maxgfr/codeindex/commit/e3420e522d1c851146e84c78124f50bdd7d4a390))


### Features

* **bench:** add MCP adapters and detection for serena, graphify, falcon ([0d7c186](https://github.com/maxgfr/codeindex/commit/0d7c186bd811c02c2924d0ab4ba5ee7ddd42eb2d))
* **bench:** add MCP stdio client and standalone probe child ([f10a5ac](https://github.com/maxgfr/codeindex/commit/f10a5acbd7dc8c951b887f3ffa82f92f260f6b6d))
* **bench:** wire MCP scenarios into the orchestrator and embed methodology ([171aed6](https://github.com/maxgfr/codeindex/commit/171aed6715cdb864fdcabe89fc1b5c6742949af9))
* **engine:** split buildIndexArtifacts into scan + buildArtifactsFromScan ([8dcce08](https://github.com/maxgfr/codeindex/commit/8dcce08f87ef27e3e18d14a8e7c9e35d656cf981))
* **grammars:** slim pull/cache tier + shared-cache resolution + per-release asset ([013b762](https://github.com/maxgfr/codeindex/commit/013b762586ee1af448ae89386a04e017a355a2f6))
* **mcp:** optional serverInfo override on runMcpServer ([00e3af7](https://github.com/maxgfr/codeindex/commit/00e3af7b9f3e1f611ea0667fbac33eb9b439f7d9))
* **scan:** change-tracking flags + precomputedWalk on RepoScan ([e50db6b](https://github.com/maxgfr/codeindex/commit/e50db6b4998d40aa39505d73dfc20717aa20b254))


### Performance Improvements

* **ast:** warm only the grammars for languages present ([f596654](https://github.com/maxgfr/codeindex/commit/f59665468863ede1ee446a2fd231eb5d97113ae9))
* **cli:** index fastpath — reuse on-disk artifacts when the scan is unchanged ([a9fae84](https://github.com/maxgfr/codeindex/commit/a9fae849699a5736adbaf9facd175c48a1437aab))
* **engine:** shared per-scan derived-structure cache ([455b30f](https://github.com/maxgfr/codeindex/commit/455b30fbd85301174bc252117df0946cf5c7c36b))
* **mcp:** session-level scan + artifacts memoization behind the stat oracle ([a8790db](https://github.com/maxgfr/codeindex/commit/a8790dbfb1b3243f3a1f0b1330b07e0ad5d3f30e))
* **walk:** dirent-typed walk — one lstat per entry, zero stats for ignored dirs ([47a8de7](https://github.com/maxgfr/codeindex/commit/47a8de7fe9f3cb5c2aa98c3507100501ebddf90a))

# [2.13.0](https://github.com/maxgfr/codeindex/compare/v2.12.0...v2.13.0) (2026-07-24)


### Bug Fixes

* **embed:** validate a custom-URL model.json before writing it ([4fd8e35](https://github.com/maxgfr/codeindex/commit/4fd8e35839d9c8cbbc266f6a901f7887082bfd9f))
* **extract:** stop capturing 'extends' as the class name of an anonymous default class export ([5c9d05b](https://github.com/maxgfr/codeindex/commit/5c9d05bc1db5404ab06bf7cb812e01ae087f94e4)), closes [#11](https://github.com/maxgfr/codeindex/issues/11)
* **walk:** exclude .codeindex from the index ([c62940f](https://github.com/maxgfr/codeindex/commit/c62940f908ac5f60be88db5dfbea88bcb489b1a6))


### Features

* **engine:** export the EmbedPullTarget type ([f088a29](https://github.com/maxgfr/codeindex/commit/f088a29220f63bb97d4006eb8648992a2aab2773))
* **scan:** configurable per-file call cap (maxCallsPerFile) ([73f864d](https://github.com/maxgfr/codeindex/commit/73f864da696d5cdc6f6a983877a37657d749f98d)), closes [#10](https://github.com/maxgfr/codeindex/issues/10)
* **walk:** replaceable ignore-directory set (ignoreDirs) ([8b4c052](https://github.com/maxgfr/codeindex/commit/8b4c052596d1d722b349ae21d60e023306b9bde3)), closes [#10](https://github.com/maxgfr/codeindex/issues/10) [#10](https://github.com/maxgfr/codeindex/issues/10)


### Performance Improvements

* **mcp:** memoize the static embed model across requests ([7ac4ce9](https://github.com/maxgfr/codeindex/commit/7ac4ce92d328f7ab7d422ff56bc1d8d0eb2fe16c))

# [2.12.0](https://github.com/maxgfr/codeindex/compare/v2.11.1...v2.12.0) (2026-07-23)


### Bug Fixes

* **docker:** ship docs/SEMANTIC.md referenced by MIGRATION.md ([4563004](https://github.com/maxgfr/codeindex/commit/4563004e598608f6c1aa2913b8be8fa639ef9b63))
* **extract:** export-alias symbols cite the original declaration's line ([c3f4c69](https://github.com/maxgfr/codeindex/commit/c3f4c69bdcb063f75a77ea0251db33003f603fdf)), closes [#9](https://github.com/maxgfr/codeindex/issues/9)
* **pkg:** ship docs/SEMANTIC.md in the npm tarball ([584ee1f](https://github.com/maxgfr/codeindex/commit/584ee1f399b4695585a830e8910489345fa686c5))


### Features

* **callers:** add buildRawCallerIndex for ungated raw recall ([#8](https://github.com/maxgfr/codeindex/issues/8)) ([4ef2553](https://github.com/maxgfr/codeindex/commit/4ef2553b9368d2adb14dd2c950a5509450cd9f71))
* **embed:** default pull URL with sha256 verification ([5e74ba0](https://github.com/maxgfr/codeindex/commit/5e74ba0f6e6ef55f3c741a021f1800088be43e15))
* **embed:** official static model conversion toolchain ([b0430cf](https://github.com/maxgfr/codeindex/commit/b0430cff1498ff8c8716c0d1c56183f8ab771618))
* **mcp:** report effective search tier instead of degrading silently ([acc158f](https://github.com/maxgfr/codeindex/commit/acc158f9df9a6706c1318f3b3aa75a6f7e3b8a79))


### Performance Improvements

* **mcp:** memoize the embedding index across server requests ([0c47a72](https://github.com/maxgfr/codeindex/commit/0c47a72960c171f6f03f4618c3aa65ddea88d053))

## [2.11.1](https://github.com/maxgfr/codeindex/compare/v2.11.0...v2.11.1) (2026-07-23)


### Bug Fixes

* **extract:** emit export-alias symbols from extractSymbols too ([a730cc4](https://github.com/maxgfr/codeindex/commit/a730cc455de2e3b7eb86710635fd8e3b7d41a5b0))
* **extract:** stop emitting C/C++ function definitions as call sites ([994cd7f](https://github.com/maxgfr/codeindex/commit/994cd7f1b460e48d517f43d5ab31ce7808f6da73))
* **extract:** suppress only the definition's own token when excluding self-calls ([0cd8b8a](https://github.com/maxgfr/codeindex/commit/0cd8b8a75827995643e144d29af01119def5e84d))

# [2.11.0](https://github.com/maxgfr/codeindex/compare/v2.10.0...v2.11.0) (2026-07-23)


### Bug Fixes

* **embed-image:** cap request body and batch size on the embedding server ([67c28cd](https://github.com/maxgfr/codeindex/commit/67c28cd9d19398b237c0e98fdb85eb690a9d598b))
* **extract:** emit symbols for export aliases ([7fcb94d](https://github.com/maxgfr/codeindex/commit/7fcb94dbc3059e8adbae4f2dab3a91343b8e4cf4))


### Features

* **embed:** containerized HTTP embedding endpoint tier ([971b922](https://github.com/maxgfr/codeindex/commit/971b922ca5d79f5323416d321d312c67eaccf4e0))

# [2.10.0](https://github.com/maxgfr/codeindex/compare/v2.9.0...v2.10.0) (2026-07-23)


### Features

* **embed:** deterministic static-embedding tier with RRF-fused semantic search ([38126f2](https://github.com/maxgfr/codeindex/commit/38126f2701887c59445576d3d8e9e3dda452dafe))

# [2.9.0](https://github.com/maxgfr/codeindex/compare/v2.8.1...v2.9.0) (2026-07-23)


### Features

* **search:** trigram fuzzy fallback for unmatched query terms ([0f1f6f3](https://github.com/maxgfr/codeindex/commit/0f1f6f37506ed4ee20c082d832ee11cdb43b80ab))

## [2.8.1](https://github.com/maxgfr/codeindex/compare/v2.8.0...v2.8.1) (2026-07-23)


### Bug Fixes

* **scip:** pin the golden's tool version so release bumps cannot invalidate it ([3a61bfb](https://github.com/maxgfr/codeindex/commit/3a61bfb510c9d86e83c9ae29c824b120e581dd13))

# [2.8.0](https://github.com/maxgfr/codeindex/compare/v2.7.0...v2.8.0) (2026-07-23)


### Bug Fixes

* **scip:** declare per-document UTF-16 position encoding ([779c54b](https://github.com/maxgfr/codeindex/commit/779c54bf20e92ad6125c7629cfbe767a6f5c9757))


### Features

* **scip:** SCIP index export with a hand-rolled zero-dep protobuf encoder ([87d93b8](https://github.com/maxgfr/codeindex/commit/87d93b81cb55e807cbba9bfc558733bf4dd9e9a1))

# [2.7.0](https://github.com/maxgfr/codeindex/compare/v2.6.0...v2.7.0) (2026-07-22)


### Bug Fixes

* **types:** drop the NodeJS namespace reference from the public declarations ([cc38559](https://github.com/maxgfr/codeindex/commit/cc385592fbf2767251f5be4183a3c23e23a6ffb3))


### Features

* **pkg:** expose the engine as an importable npm library ([1ab3020](https://github.com/maxgfr/codeindex/commit/1ab30208116e82dbc5e0e00c9f70e3645c3d7f30))

# [2.6.0](https://github.com/maxgfr/codeindex/compare/v2.5.0...v2.6.0) (2026-07-22)


### Features

* **ast:** tree-sitter grammars for scala, bash, and lua ([c9cb760](https://github.com/maxgfr/codeindex/commit/c9cb760af831b7acdd9468f3b39293097492ee24))

# [2.5.0](https://github.com/maxgfr/codeindex/compare/v2.4.0...v2.5.0) (2026-07-22)


### Features

* **categorize:** archive/executable extensions as assets, astro language ([dfbf6ac](https://github.com/maxgfr/codeindex/commit/dfbf6ac4245fb23ceefd8b37fc4216f48ed57008)), closes [#6](https://github.com/maxgfr/codeindex/issues/6)
* dead-code tiers, cyclomatic complexity × churn risk, mermaid diagrams ([44fdb58](https://github.com/maxgfr/codeindex/commit/44fdb588b7d60a52932851e81836fa784ad2382f))
* **extract:** call-site receivers and JS/TS export parity (extractor v6) ([e0533ae](https://github.com/maxgfr/codeindex/commit/e0533aec88e08d2e009addf839c1dee7b468a4ee)), closes [#1](https://github.com/maxgfr/codeindex/issues/1)
* **grep:** negation globs with identical semantics on both backends ([e1b7d45](https://github.com/maxgfr/codeindex/commit/e1b7d459d02fc7b9afdc62f3ff581e23eb38927c)), closes [#3](https://github.com/maxgfr/codeindex/issues/3)
* keyless BM25 search, architecture rules, recall-oriented caller index ([f1096a6](https://github.com/maxgfr/codeindex/commit/f1096a6aacea7318fbacdee0ba272c9679cef64f)), closes [#4](https://github.com/maxgfr/codeindex/issues/4) [#4](https://github.com/maxgfr/codeindex/issues/4) [#7](https://github.com/maxgfr/codeindex/issues/7)
* **resolve:** SFC/HTML import candidates and bare tsconfig extends ([70db135](https://github.com/maxgfr/codeindex/commit/70db135e3fa687a65b1af939fe5565bcd4d6d869)), closes [#5](https://github.com/maxgfr/codeindex/issues/5)
* **walk:** count and surface excluded files on WalkResult and RepoScan ([0e0418d](https://github.com/maxgfr/codeindex/commit/0e0418d33d752eba3638370c230e91d3682b11e9)), closes [#6](https://github.com/maxgfr/codeindex/issues/6)
* **workspaces:** uv workspaces, Composer path repos, Gradle includes, nested globs, descriptions, warnings ([b161d82](https://github.com/maxgfr/codeindex/commit/b161d820e77ed449682c1fa886a87a42971d993b)), closes [#2](https://github.com/maxgfr/codeindex/issues/2) [#6](https://github.com/maxgfr/codeindex/issues/6)

# [2.4.0](https://github.com/maxgfr/codeindex/compare/v2.3.0...v2.4.0) (2026-07-22)


### Features

* symbolic editing and project memories (Serena-parity, static edition) ([d363003](https://github.com/maxgfr/codeindex/commit/d363003acbf077ec9c7d9ca894585408059d82d1))

# [2.3.0](https://github.com/maxgfr/codeindex/compare/v2.2.0...v2.3.0) (2026-07-22)


### Features

* **query:** symbol overview, name-path lookup and tiered references ([7d95498](https://github.com/maxgfr/codeindex/commit/7d954988dd472e1c0495f3c9ba740bf2e17944c1))

# [2.2.0](https://github.com/maxgfr/codeindex/compare/v2.1.0...v2.2.0) (2026-07-22)


### Features

* change coupling, hotspot ranking and token-budgeted repo map ([3879f41](https://github.com/maxgfr/codeindex/commit/3879f41a1244a4fa39d6b16be1963c37fc0a6042)), closes [hi#leverage](https://github.com/hi/issues/leverage)

# [2.1.0](https://github.com/maxgfr/codeindex/compare/v2.0.1...v2.1.0) (2026-07-22)


### Features

* **cli:** build the CLI wrapper from TypeScript ([d39c000](https://github.com/maxgfr/codeindex/commit/d39c0006fb95bac853535e1fb0152b0e09c1164b))

## [2.0.1](https://github.com/maxgfr/codeindex/compare/v2.0.0...v2.0.1) (2026-07-22)


### Bug Fixes

* adversarial-review findings across the new surfaces ([867b626](https://github.com/maxgfr/codeindex/commit/867b62667778cde5e32288a8d18c3c148e895ade))

# [2.0.0](https://github.com/maxgfr/codeindex/compare/v1.1.1...v2.0.0) (2026-07-22)


* fix(engine)!: pure library bundle, CLI moved to a static wrapper ([2216445](https://github.com/maxgfr/codeindex/commit/2216445da21ce55910fdd92ebb936080090eba49))


### BREAKING CHANGES

* run the CLI as `node scripts/cli.mjs <cmd>` (or the
codeindex bin) — executing engine.mjs directly no longer dispatches commands.

## [1.1.1](https://github.com/maxgfr/codeindex/compare/v1.1.0...v1.1.1) (2026-07-22)


### Bug Fixes

* **ignore:** full fnmatch conformance with git check-ignore ([0e82ec8](https://github.com/maxgfr/codeindex/commit/0e82ec824517231312dd2bbdab0b0b9fb274ed1e))

# [1.1.0](https://github.com/maxgfr/codeindex/compare/v1.0.0...v1.1.0) (2026-07-22)


### Features

* **cli:** single-pass index command with incremental cache ([4b8f7e3](https://github.com/maxgfr/codeindex/commit/4b8f7e3737fe40e614bda406b192d1542ec4a1ce))

# 1.0.0 (2026-07-22)


### Features

* bootstrap engine core extracted from ultraindex 5.1.0 ([921c927](https://github.com/maxgfr/codeindex/commit/921c92799b03f4465da2463c8e7266b6b6242d8e))
* superset tier — callers, churn, categorize, workspaces, grep, C/C++ AST, MCP server ([1c7c44a](https://github.com/maxgfr/codeindex/commit/1c7c44aee5c161c955b247b5bedb54362a930175))
* **walk:** honor .gitignore and guard symlink escapes ([78950c7](https://github.com/maxgfr/codeindex/commit/78950c708dca747ed3b0c2b0f6789675888fa74c))

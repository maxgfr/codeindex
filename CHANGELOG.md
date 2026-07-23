# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

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

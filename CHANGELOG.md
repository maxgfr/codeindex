# Changelog

All notable changes to this project are documented here, generated automatically from the [Conventional Commits](https://www.conventionalcommits.org/) by [semantic-release](https://github.com/semantic-release/semantic-release).

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

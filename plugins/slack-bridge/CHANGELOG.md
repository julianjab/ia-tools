# Changelog

## [0.5.0](https://github.com/julianjab/ia-tools/compare/slack-bridge-v0.4.1...slack-bridge-v0.5.0) (2026-05-13)


### Features

* persist SLACK_TOPICS subs + new /router skill ([#50](https://github.com/julianjab/ia-tools/issues/50)) ([d96bcff](https://github.com/julianjab/ia-tools/commit/d96bcff8c6e2973e419a0705e4afeea16cd73e33))

## [0.4.1](https://github.com/julianjab/ia-tools/compare/slack-bridge-v0.4.0...slack-bridge-v0.4.1) (2026-05-13)


### Bug Fixes

* **team-workflow:** correct MCP tools allowlist prefix ([#47](https://github.com/julianjab/ia-tools/issues/47)) ([f48716a](https://github.com/julianjab/ia-tools/commit/f48716aab91c8249905fbb91dd36fe89007d27cd))

## [0.4.0](https://github.com/julianjab/ia-tools/compare/slack-bridge-v0.3.0...slack-bridge-v0.4.0) (2026-05-08)


### Features

* **orchestration:** multi-repo fan-out — scope-check, N PRs, prose delegation ([#27](https://github.com/julianjab/ia-tools/issues/27)) ([7809bc3](https://github.com/julianjab/ia-tools/commit/7809bc3502e75b29a8d1b01046fb8fd607c20372))
* **slack-bridge:** correlate session id end-to-end (file settle gate + daemon route logs) + SRP split ([#39](https://github.com/julianjab/ia-tools/issues/39)) ([ec706ad](https://github.com/julianjab/ia-tools/commit/ec706ad38a43d275fc5b6d3640c95380bcc8536f))
* **slack-bridge:** only process channel messages when bot is mentioned ([#42](https://github.com/julianjab/ia-tools/issues/42)) ([c91b3e6](https://github.com/julianjab/ia-tools/commit/c91b3e6091e9962c5bed90175ebcf5447d8b3dae))
* **slack-bridge:** session-scoped config + auth gate + list_subscriptions ([#37](https://github.com/julianjab/ia-tools/issues/37)) ([8ee2f00](https://github.com/julianjab/ia-tools/commit/8ee2f00d1d0f682b77682a07d4f9801648930a3e))
* **slack-bridge:** Slack Agent + access control + streaming + MCP-side ack ([#44](https://github.com/julianjab/ia-tools/issues/44)) ([56b2a7c](https://github.com/julianjab/ia-tools/commit/56b2a7c043b1f1a7151eb21e9b6d55b62c2c5331))
* **slack-bridge:** topic-based subscriptions, per-topic labels, lifecycle + UX ([#34](https://github.com/julianjab/ia-tools/issues/34)) ([6b4690f](https://github.com/julianjab/ia-tools/commit/6b4690f6030b81342f6670e3d381a91e81ccec3b))


### Bug Fixes

* **task:** write worktree settings to settings.local.json ([#25](https://github.com/julianjab/ia-tools/issues/25)) ([a5265f7](https://github.com/julianjab/ia-tools/commit/a5265f75f1cccf7a50c2d7e937c615c724014a85))


### Refactors

* **agents:** rewrite orchestrator as agent-team lead ([#24](https://github.com/julianjab/ia-tools/issues/24)) ([160917d](https://github.com/julianjab/ia-tools/commit/160917db57eb974ac280d094902f58f32baa2c28))
* move session-manager role into slack-bridge MCP, delete SessionStart hook ([#38](https://github.com/julianjab/ia-tools/issues/38)) ([7b178bc](https://github.com/julianjab/ia-tools/commit/7b178bcb73c97529b8bbe264f89975ca621574d2))
* orchestrator builtin agents + slack-bridge pure transport ([#40](https://github.com/julianjab/ia-tools/issues/40)) ([fb4cf77](https://github.com/julianjab/ia-tools/commit/fb4cf77bde05fe7ae05d69b3999d94ce6a45dcc7))
* **slack-bridge:** move MCP server into self-contained plugin dir ([#22](https://github.com/julianjab/ia-tools/issues/22)) ([cefe31a](https://github.com/julianjab/ia-tools/commit/cefe31a40c163b2e483646ffbb1f2234ec80b316))
* **slack-bridge:** unify path + logging in shared utility classes ([#36](https://github.com/julianjab/ia-tools/issues/36)) ([52f9685](https://github.com/julianjab/ia-tools/commit/52f968512115a44c8c2bfebf0b4e02e41a69b7d6))

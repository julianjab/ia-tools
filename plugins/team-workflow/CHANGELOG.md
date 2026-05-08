# Changelog

## [0.3.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.2.0...team-workflow-v0.3.0) (2026-05-08)


### Features

* **slack-bridge:** topic-based subscriptions, per-topic labels, lifecycle + UX ([#34](https://github.com/julianjab/ia-tools/issues/34)) ([6b4690f](https://github.com/julianjab/ia-tools/commit/6b4690f6030b81342f6670e3d381a91e81ccec3b))
* **team-workflow:** generic tool guard hook (Bash, Edit, Write, WebFetch) ([#43](https://github.com/julianjab/ia-tools/issues/43)) ([9e29f40](https://github.com/julianjab/ia-tools/commit/9e29f40e7b751173afaba5d8cf6a74778fd0ae9b))


### Bug Fixes

* **session-start:** default role to session-manager, not triage ([#32](https://github.com/julianjab/ia-tools/issues/32)) ([1a80e71](https://github.com/julianjab/ia-tools/commit/1a80e71e272330bd2f71c3a3c0d8f518394d4a03))
* **team-workflow:** make plugin self-contained — move agents/hooks/skills inside ([#31](https://github.com/julianjab/ia-tools/issues/31)) ([899525e](https://github.com/julianjab/ia-tools/commit/899525e13d0ccec5fc73fae91b5c77529da402f9))


### Refactors

* move session-manager role into slack-bridge MCP, delete SessionStart hook ([#38](https://github.com/julianjab/ia-tools/issues/38)) ([7b178bc](https://github.com/julianjab/ia-tools/commit/7b178bcb73c97529b8bbe264f89975ca621574d2))
* orchestrator builtin agents + slack-bridge pure transport ([#40](https://github.com/julianjab/ia-tools/issues/40)) ([fb4cf77](https://github.com/julianjab/ia-tools/commit/fb4cf77bde05fe7ae05d69b3999d94ce6a45dcc7))
* **team-workflow:** native primitives — session-manager router, simpler /session, plan/tasks/memory orchestrator ([#33](https://github.com/julianjab/ia-tools/issues/33)) ([52b59fc](https://github.com/julianjab/ia-tools/commit/52b59fcbf4996fabf4c12a684fc6dd64c3644679))
* **team-workflow:** start-session.sh — argv-based prompt + function split ([#35](https://github.com/julianjab/ia-tools/issues/35)) ([d1fe429](https://github.com/julianjab/ia-tools/commit/d1fe4296ebaa7e7a5d1b11c0905378c5687e6e8a))

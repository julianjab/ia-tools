# Changelog

## [1.3.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v1.2.0...team-workflow-v1.3.0) (2026-05-21)


### Features

* **team-workflow:** session-env.yaml + /worktree rehydrate works outside lead sessions ([#100](https://github.com/julianjab/ia-tools/issues/100)) ([40b5f7a](https://github.com/julianjab/ia-tools/commit/40b5f7a7e076cb7ccc61ed869cd118a3de1fbce0))

## [1.2.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v1.1.0...team-workflow-v1.2.0) (2026-05-21)


### Features

* **team-workflow:** /worktree rehydrate + SessionStart nudge after context loss ([#98](https://github.com/julianjab/ia-tools/issues/98)) ([4f1142f](https://github.com/julianjab/ia-tools/commit/4f1142fe0a199616667fbfe6bb0249c6b45d9798))

## [1.1.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v1.0.0...team-workflow-v1.1.0) (2026-05-21)


### Features

* **team-workflow:** script-followups — bucket split, intelligence detectors, prompt-first user-correction ([#95](https://github.com/julianjab/ia-tools/issues/95)) ([7f0cbd5](https://github.com/julianjab/ia-tools/commit/7f0cbd5e94e5506682e12f7b2806899f278a1182))

## [1.0.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.11.0...team-workflow-v1.0.0) (2026-05-21)


### ⚠ BREAKING CHANGES

* **slack-bridge:** atomic reply with built-in claim + agent realignment ([#83](https://github.com/julianjab/ia-tools/issues/83))

### Features

* **scaffold:** script-author + structured-bash dogfood across team-workflow hooks ([#84](https://github.com/julianjab/ia-tools/issues/84)) ([72948c3](https://github.com/julianjab/ia-tools/commit/72948c30929647ea0a9fa13dd77d35276518395f))
* **slack-bridge:** atomic reply with built-in claim + agent realignment ([#83](https://github.com/julianjab/ia-tools/issues/83)) ([49b0ed5](https://github.com/julianjab/ia-tools/commit/49b0ed5cdf610a2e364c99f6f33550bb69a72b25))

## [0.11.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.10.0...team-workflow-v0.11.0) (2026-05-21)


### Features

* **session:** support iTerm2 host alongside tmux via IA_TW_TERMINAL ([#89](https://github.com/julianjab/ia-tools/issues/89)) ([bcacfb5](https://github.com/julianjab/ia-tools/commit/bcacfb550c943aba0a3ac59f7ab8a8b70991cf8a))

## [0.10.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.9.0...team-workflow-v0.10.0) (2026-05-21)


### Features

* **team-workflow:** atomic-commits-per-layer contract + cadence check ([#80](https://github.com/julianjab/ia-tools/issues/80)) ([bbf0eb6](https://github.com/julianjab/ia-tools/commit/bbf0eb670c4edcf13a4fdf65242764cfdf634c81))

## [0.9.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.8.0...team-workflow-v0.9.0) (2026-05-21)


### Features

* **team-workflow:** declarative pod config + persona overlays + bridge wildcard ACL ([#78](https://github.com/julianjab/ia-tools/issues/78)) ([3d85e10](https://github.com/julianjab/ia-tools/commit/3d85e10519658b3049f7bafa1e0e963761180f01))
* **team-workflow:** deterministic router dispatch + per-topic worker ([#75](https://github.com/julianjab/ia-tools/issues/75)) ([636a720](https://github.com/julianjab/ia-tools/commit/636a7207106264bbc793bec6779f1574c6c3c56b))
* **team-workflow:** make /pr CI watch context-aware ([#76](https://github.com/julianjab/ia-tools/issues/76)) ([4a2ecac](https://github.com/julianjab/ia-tools/commit/4a2ecac29d2d233db61c2ea1d10956f47d5a7ac7))
* **team-workflow:** package as configurable Docker image with repo-worker ([#77](https://github.com/julianjab/ia-tools/issues/77)) ([0172193](https://github.com/julianjab/ia-tools/commit/0172193bd4a899b0c73b0cefcd586d4a8fdbb5c0))
* **team-workflow:** send-session-message skill + local-mode Slack fallback ([#79](https://github.com/julianjab/ia-tools/issues/79)) ([dbc6b2a](https://github.com/julianjab/ia-tools/commit/dbc6b2a2cd15e3f948d3fe0f71607b47ad8b1b1b))


### Bug Fixes

* **team-workflow:** deterministic state.md bookkeeping + session-end fixes ([#81](https://github.com/julianjab/ia-tools/issues/81)) ([cbeedd0](https://github.com/julianjab/ia-tools/commit/cbeedd0fac61b84a31612df715967968ba01bb88))

## [0.8.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.7.0...team-workflow-v0.8.0) (2026-05-14)


### Features

* **team-workflow:** make P:qa:red optional for infra/config changes ([#68](https://github.com/julianjab/ia-tools/issues/68)) ([aa8b54d](https://github.com/julianjab/ia-tools/commit/aa8b54d02298c1bce3acd112316706ad39b2d244))

## [0.7.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.6.1...team-workflow-v0.7.0) (2026-05-14)


### Features

* **slack-bridge:** channel thread replies + emoji reactions + 4-branch auth gate ([#65](https://github.com/julianjab/ia-tools/issues/65)) ([e517ae4](https://github.com/julianjab/ia-tools/commit/e517ae4e97c5a867dbd98b7a000f097a8adb521c))
* **team-review:** auto-inject repo-type reviewer based on git remote ([#64](https://github.com/julianjab/ia-tools/issues/64)) ([0d27828](https://github.com/julianjab/ia-tools/commit/0d27828a67ba6cdccfb2e21ed87c46605d60952c))


### Bug Fixes

* **ci:** remove path-traversal extra-files from release-please config ([#66](https://github.com/julianjab/ia-tools/issues/66)) ([9f89a5d](https://github.com/julianjab/ia-tools/commit/9f89a5d8b0cb5c1e60ef813349fd0ce04fb53ab6))

## [0.6.1](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.6.0...team-workflow-v0.6.1) (2026-05-13)


### Refactors

* **slack-bridge:** remove SLACK_BRIDGE_DEV_CHANNELS bypass ([#61](https://github.com/julianjab/ia-tools/issues/61)) ([8b3fe83](https://github.com/julianjab/ia-tools/commit/8b3fe83dba2356bbcf99bda78829fc28580f921b))

## [0.6.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.5.2...team-workflow-v0.6.0) (2026-05-13)


### Features

* **router:** make topic optional at boot ([#59](https://github.com/julianjab/ia-tools/issues/59)) ([e620a3a](https://github.com/julianjab/ia-tools/commit/e620a3a6517ac473e0a809f3d163619e2017cf38))

## [0.5.2](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.5.1...team-workflow-v0.5.2) (2026-05-13)


### Bug Fixes

* **slack-bridge:** accept SLACK_BRIDGE_DEV_CHANNELS env to bypass parent-argv check ([#55](https://github.com/julianjab/ia-tools/issues/55)) ([8d3aa1e](https://github.com/julianjab/ia-tools/commit/8d3aa1e332c77aea75d331772676a4f32d494db8))

## [0.5.1](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.5.0...team-workflow-v0.5.1) (2026-05-13)


### Bug Fixes

* **team-workflow:** tool-guard minimize built-in PATTERNS and ignore quoted strings ([#53](https://github.com/julianjab/ia-tools/issues/53)) ([667296e](https://github.com/julianjab/ia-tools/commit/667296e73f6f9a6c0eab295ab6bcb9818f26af8a))

## [0.5.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.4.0...team-workflow-v0.5.0) (2026-05-13)


### Features

* persist SLACK_TOPICS subs + new /router skill ([#50](https://github.com/julianjab/ia-tools/issues/50)) ([d96bcff](https://github.com/julianjab/ia-tools/commit/d96bcff8c6e2973e419a0705e4afeea16cd73e33))

## [0.4.0](https://github.com/julianjab/ia-tools/compare/team-workflow-v0.3.0...team-workflow-v0.4.0) (2026-05-13)


### Features

* **team-workflow:** align with agent-teams + agent-view docs ([#48](https://github.com/julianjab/ia-tools/issues/48)) ([5644cb4](https://github.com/julianjab/ia-tools/commit/5644cb4ba9cfb0b4aca56d4b4d2ad799bd380ce4))


### Bug Fixes

* **team-workflow:** correct MCP tools allowlist prefix ([#47](https://github.com/julianjab/ia-tools/issues/47)) ([f48716a](https://github.com/julianjab/ia-tools/commit/f48716aab91c8249905fbb91dd36fe89007d27cd))

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

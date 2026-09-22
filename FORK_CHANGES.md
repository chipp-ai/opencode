# Fork changes

This is [chipp-ai/opencode](https://github.com/chipp-ai/opencode), a public fork of [anomalyco/opencode](https://github.com/anomalyco/opencode). This file tracks everything this fork has added or changed on top of upstream, so anyone landing here knows what's different without diffing branches by hand.

Each entry names the upstream gap it addresses, whether it originated as our own work or was adapted from an abandoned community attempt upstream, and where to look for the actual commits.

## Implemented

### Subagent cost rollup

Session cost/tokens shown in the TUI sidebar and footer, `opencode stats`, and ACP's `usage_update` now include spend from subagent (Task tool) sessions, not just the root session. Also fixes the V2 session runner reporting `$0` cost for every session, and forked sessions double-counting their source session's pre-fork spend.

- **Upstream gap:** [anomalyco/opencode#45417](https://github.com/anomalyco/opencode/issues/45417), [#39740](https://github.com/anomalyco/opencode/issues/39740), [#40114](https://github.com/anomalyco/opencode/issues/40114), [#31032](https://github.com/anomalyco/opencode/issues/31032) — all open, unmerged upstream (the one real implementation, [PR #43645](https://github.com/anomalyco/opencode/pull/43645), was auto-closed by upstream's PR-cleanup bot before maintainer review).
- **Origin:** written from scratch for this fork, informed by the closed upstream PR's approach.
- **Where:** [`dev` branch history](https://github.com/chipp-ai/opencode/commits/dev), commits `7481668`..`040bb3d` (core pricing/rollup, protocol endpoint, TUI display, stats attribution, ACP, fork-cost fix).

## In progress

### Dynamic workflows

Claude-Code-style project-local workflows: a `.ts`/`.js` file controls orchestration deterministically (loops, branching, parallel fan-out, staged pipelines) instead of leaving it to the model, with `agent()`/`parallel()`/`pipeline()`/`phase()` primitives dispatching isolated subagent sessions.

- **Upstream gap:** [anomalyco/opencode#29059](https://github.com/anomalyco/opencode/issues/29059) (closed by stale-bot) and [#30308](https://github.com/anomalyco/opencode/issues/30308) (open). A substantial community implementation existed — [PR #29789](https://github.com/anomalyco/opencode/pull/29789) (still open, unmerged, `CONFLICTING`) plus a 6-PR reviewable split ([#32390](https://github.com/anomalyco/opencode/pull/32390)–[#32396](https://github.com/anomalyco/opencode/pull/32396)) — all closed unmerged by the same automated PR-cleanup bot, with zero maintainer engagement across the entire multi-month thread.
- **Origin:** adapting design and reusable pieces (workflow file discovery/AST-metadata reading, the Claude-Code-compatible "bare globals" script format, TUI dialog concepts, docs) from the abandoned upstream attempt. The core agent-dispatch engine is being rewritten against the current V2 session runner rather than reused as-is — the original implementation dispatches through the legacy V1 session/prompt loop, which this repo's own architecture rules (see `AGENTS.md`) say new orchestration code must not do.
- **Where:** in progress on `dev`; this section will move to "Implemented" with commit references once it lands.

---

Also referenced from the [README](./README.md#fork-changes).

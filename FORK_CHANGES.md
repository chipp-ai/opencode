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

Claude-Code-style project-local workflows: a script controls orchestration deterministically (loops, branching, parallel fan-out, staged pipelines) instead of leaving it to the model, with `agent()`/`parallel()`/`pipeline()`/`phase()`/`log()`/`budget` primitives dispatching isolated subagent sessions.

- **Upstream gap:** [anomalyco/opencode#29059](https://github.com/anomalyco/opencode/issues/29059) (closed by stale-bot) and [#30308](https://github.com/anomalyco/opencode/issues/30308) (open). A substantial community implementation existed — [PR #29789](https://github.com/anomalyco/opencode/pull/29789) (still open, unmerged, `CONFLICTING`) plus a 6-PR reviewable split ([#32390](https://github.com/anomalyco/opencode/pull/32390)–[#32396](https://github.com/anomalyco/opencode/pull/32396)) — all closed unmerged by the same automated PR-cleanup bot, with zero maintainer engagement across the entire multi-month thread.
- **Origin:** design informed by the abandoned upstream attempt (~55-65% of its ~35k-line diff was reusable: discovery/meta/lint, the persisted schema, TUI dialogs, HTTP route schema); the agent-dispatch core is written from scratch against the current V2 session runner rather than reused, since the original dispatches through the legacy V1 session/prompt loop, which this repo's own architecture rules (`AGENTS.md`) say new orchestration code must not do. Also fixes a real bug found in a separate community branch's "bare globals" script format (Claude-Code-compatible bare `agent()`/`parallel()`/etc. globals): `pipeline` was defined but never actually injected, so scripts calling it threw `ReferenceError`.
- **Status — phased rollout, each phase independently shipped and tested:**
  - ✅ **Phase 0 — missing V2 primitives.** `SessionV2.wait` was a hardcoded stub; implemented for real via a new `SessionRunCoordinator.join` (awaits a key's current drain without ever force-starting one, with a `lastDone`-map fix for the case where a zero-async-boundary drain settles before the caller gets a scheduling turn). Added `parentID` to `SessionV2.create` (schema/projector/rollup already supported it end-to-end). Added `SessionHistory.lastAssistant`.
  - ✅ **Phase 1 — minimal V2-native engine.** `WorkflowAgentDispatch` (one-shot isolated subagent dispatch: ephemeral per-call `AgentV2.Info` registration with auto-cleanup, `SessionV2.create`→`prompt`→`wait`→`SessionHistory.lastAssistant`, never touching the V1 loop) and `WorkflowEngine` (the `agent`/`parallel`/`pipeline`/`phase`/`log`/`budget` orchestration core — Promise-based to match real workflow scripts, bridged to Effect via `Effect.context()`/`Effect.runPromiseWith`; USD-based budget using the cost-rollup work's own pricing, not a token pool). A provisional `opencode debug workflow <file>` CLI command makes it runnable today (no sandboxing or discovery yet — Phase 4/5). Verified live against a real V2 session/runner/coordinator pipeline (unit+integration tests) and against a real provider network call (blocked only by environment credential/API-support limits in the verification sandbox, not a code defect).
  - ✅ **Phase 2 — structured output.** `agent(prompt, {schema})` resolves to the captured tool-call object. Deliberately avoids forcing `toolChoice: "required"` in the shared V2 runner (that logic runs for every session, not just workflows) — instead a strong system-prompt nudge plus a scoped, auto-cleaned-up `StructuredOutput` tool whose call races (`Effect.raceAll`) against session settlement and an optional timeout, interrupting the session immediately on a structured-tool win. **Known gap:** the captured value isn't deep-validated against the schema (no JSON-Schema-to-validator compiler available) — advertised via the tool description text, but a schema-violating call still succeeds rather than retrying.
  - ✅ **Phase 3a — run persistence + journal-based resume.** Every run persists to a standalone `workflow_run` table (no FK, reusable near-verbatim from the community schema) with a journal of each live `agent()` call's (prompt, opts) key and result, updated after every call so a crash loses at most one in-flight call. `resumeFromRunId` replays the journal: the unchanged prefix returns cached results at zero cost (seeding `budget.spent()` correctly), diverging to live dispatch from the first changed call onward — "same script + same args → 100% cache hit." Verified both in tests and live against the real CLI/DB stack (a failed run's error is recorded with an empty journal; resuming it correctly links `resume_of` and retries live since nothing was cached). **Known gaps:** journal position isn't guaranteed to align with source order for calls inside a single `parallel()`/`pipeline()` batch (worst case: extra live re-dispatches); no cascading cancellation of an already-in-flight dispatch when the run is interrupted (the row is correctly marked `cancelled`, but a dispatch already bridged through `Effect.runPromiseWith` keeps running).
  - ⬜ **Phase 3b — worktree isolation.** `isolation: 'worktree'` per-agent-call — the worktree create/teardown mechanics are proven and reusable from `packages/opencode/src/worktree/index.ts`, but aren't reachable from `packages/core` yet.
  - ⬜ **Phase 4 — sandboxed script execution.** Real `vm`-based sandboxing (not the community's unsafe `new Function` in the host global scope) with the full real global set, including the `pipeline` fix above.
  - ⬜ **Phase 5 — HTTP API + discovery.** `.opencode/workflows/` discovery, `/workflow` `/workflows` slash commands, SDK regen.
  - ⬜ **Phase 6 — TUI dialogs + docs.**
- **Where:** [`dev` branch history](https://github.com/chipp-ai/opencode/commits/dev), commits `c76c57f`..`e18c0fe` (Phase 0-3a).

---

Also referenced from the [README](./README.md#fork-changes).

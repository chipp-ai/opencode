# Selective upstream compatibility review

## Compared revisions

- Fork: `chipp-ai/opencode`, `dev` at `04b37650c3e36d69da08aff9db28698fdf2f5360`.
- Upstream: `anomalyco/opencode`, `dev` at `f6e0c2d0833ffe772035f221fed923e1cd5fb408`.
- Merge base: `2406400f0aeb07b36d0495af4e05aaca49159832`.
- Before this batch: 97 fork-only commits and 6,911 upstream-only commits, including merge history.

The upstream branch includes the V2 cutover, package renaming, tool/plugin redesign, newer Effect APIs, and a changed session/event implementation. A merge that resolves text conflicts is not sufficient evidence of runtime compatibility. This review selects independently testable fixes; it is not an exhaustive audit of every intervening commit.

## Accepted changes

| Upstream source      | Adaptation                                                       | Verification                                                                                      |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `dc21f528ac`, #59197 | Same-resolved-path move guard in legacy `apply_patch`            | Real file remains present with edited content; metadata reports an update                         |
| `54de420baa`, #62575 | Surrogate-safe line truncation in the existing streaming reader  | Exact returned text at EOF, newline, and chunk boundaries                                         |
| `17837a20d6`, #59748 | Manually follow redirects with permission checks before each hop | Real HTTP server proves a denied destination receives no request                                  |
| `125655ec6f`, #61701 | Reject URL credentials and strip fragments in V2 webfetch        | No permission or transport call for credential-bearing input; fragment cannot evade an exact deny |
| `e803323c13`, #62373 | Retain written-URL matching for the initial request              | Existing URL/permission tests remain valid                                                        |

These are adapted backports with source attribution, not claims that the complete upstream commits were cherry-picked. The legacy patch fix does not introduce V2 move support or upstream's multi-hunk virtual filesystem. The URL changes do not introduce Code Mode or change the legacy webfetch implementation.

## Deferred after inspection

- **Case-only patch renames (`2f8a867eae`, #63655):** the upstream fix targets the newer patch/environment filesystem abstraction. The existing V2 tool rejects moves. Backporting it requires separate filesystem-alias tests, including a case-insensitive filesystem.
- **Mixed-line-ending edits (`0cb434775c`, #53166):** useful, but depends on matching and line-alignment machinery absent from this fork's exact-edit tool. Preserve the exact-match and stale-write guarantees when adapting it in a separate change.
- **Tail-read memory fix (`464688ba68`, #63030):** targets a tail-reading implementation this fork does not have. Its current reader already streams forward and bounds retained line content.
- **MCP permission metadata (`328f74c213`, #51062):** targets a newer MCP tool registration module absent from this tree. Carry the behavior into a deliberate MCP/tool migration rather than adding a parallel registration path.
- **Rate-limit classifier (`1002a979f9`, #59816):** the newer `packages/ai` quota classification logic is absent from this fork's `packages/llm` implementation. The one-line regex change is not applicable here.
- **New background subagent defaults, shell process daemon, schedules, artifacts, and GUI work:** depend on newer lifecycle and public API contracts. These are feature migrations, not isolated fixes.
- **Package-scope, Effect, and SDK changes:** migrate together with their callers and generated clients. Avoid dependency bumps as incidental cleanup.

## Preserve the fork's behavior during a larger migration

The comparison must account for model fallback and circular fallback, dynamic workflows, queued-input editing, cost rollups, provider discovery, per-agent instruction controls, `.mcp.json` handling, and the fork's TUI behavior. Where upstream now implements an equivalent feature, compare behavior and stored data before replacing the fork implementation.

The headless backports already in this fork also need explicit retention checks:

- Bun-native HTTP transport and disconnect cleanup.
- LSP process-tree teardown and idle shutdown.
- Opt-in instance eviction with active-use leases.
- Retry budgets, jitter, and `Retry-After` support.
- Composition-time HTTP route extensions.
- Durable-event payload policy and non-blocking session resume.

## One shared runtime

The recommended destination is one public OpenCode runtime with downstream-specific behavior supplied by an adapter. An adapter can live in the consuming application's existing repository, avoiding a second OpenCode fork.

Do not treat the current event payload hook as an external durability interface. `EventV2.LayerOptions.persist` is explicitly a pure, idempotent payload transformation. It cannot await remote acknowledgment, carry delivery failures, or manage a durable delivery cursor. A downstream requiring those guarantees needs an explicit effectful publication/delivery interface with replay semantics and failure tests.

Before retiring any downstream runtime, verify command acceptance, idempotent retries, replay and restore, parent/child execution identity, provider headers and credential refresh, worktree placement, interruption, and idle resource cleanup against the shared build. This compatibility batch does not perform that migration or certify downstream production compatibility.

## Reproduction

Verified with 199 passing core regression tests across 22 files and 29 passing legacy patch tests. Both affected packages typecheck. Changed-file lint reports zero errors and seven warnings on unchanged lines. New regression cases were also run against the original implementation and failed before the fixes. Two initial test timeouts under concurrent typechecking disappeared on isolated reruns; the complete selected core batch then passed. The whole repository and downstream production runtime were not exercised.

Use the pinned Bun 1.3.14 from `package.json`. Run tests from package directories.

```sh
# packages/core
bun test test/tool-read-filesystem.test.ts test/tool-webfetch.test.ts
bun test test/tool-*.test.ts test/session-runner-fallback.test.ts test/workflow-*.test.ts test/util/process-tree.test.ts test/util/idle-lease.test.ts test/util/retry.test.ts test/event-persist-policy.test.ts
bun typecheck

# packages/opencode
bun test test/tool/apply_patch.test.ts
bun typecheck
```

No dependency, generated client, database migration, release version, or installed runtime changes are required for this batch.

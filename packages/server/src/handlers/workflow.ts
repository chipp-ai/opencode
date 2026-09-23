import { Location } from "@opencode-ai/core/location"
import { WorkflowEngine } from "@opencode-ai/core/workflow/engine"
import { WorkflowRegistry } from "@opencode-ai/core/workflow/registry"
import type { WorkflowRunStore } from "@opencode-ai/core/workflow/store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { WorkflowNotFoundError, WorkflowRunNotFoundError } from "@opencode-ai/protocol/groups/workflow"
import { Api } from "../api"
import { response } from "../location"

/**
 * `workflow.run` blocks for the run's full duration and returns its final result -- there's no
 * streaming progress endpoint yet (`phase()`/`log()` calls just complete silently over HTTP).
 * No `isolation: 'worktree'` support here either: the real Worktree.Service adapter lives in
 * `packages/opencode` (app-layer -- InstanceStore/Project/Git/AppProcess deps that
 * `packages/server` and `packages/core` must not depend on), and isn't wired into this handler
 * yet -- a script requesting worktree isolation over HTTP fails loudly with
 * `WorktreeIsolationUnconfiguredError` rather than silently ignoring it. See FORK_CHANGES.md.
 *
 * Goes through WorkflowRegistry.Service rather than yielding Database.Service/FSUtil.Service
 * directly -- doing the latter leaked them into the compiled Api's own handler type graph in a
 * way `Layer.provide` never cleans up, breaking `packages/cli`'s daemon typecheck several
 * packages away. Every other handler in this file avoids the same trap by only ever depending on
 * a domain service (SessionV2.Service, SkillV2.Service, ...) that already closes its own
 * Database/FSUtil dependency internally.
 */
export const WorkflowHandler = HttpApiBuilder.group(Api, "server.workflow", (handlers) =>
  handlers
    .handle("workflow.list", () =>
      response(
        Effect.gen(function* () {
          const location = yield* Location.Service
          const registry = yield* WorkflowRegistry.Service
          return yield* registry.list(location.directory)
        }),
      ),
    )
    .handle(
      "workflow.run",
      Effect.fn(function* (ctx) {
        return yield* response(
          Effect.gen(function* () {
            const location = yield* Location.Service
            const registry = yield* WorkflowRegistry.Service
            const found = yield* registry.find(location.directory, ctx.params.id)
            if (!found) {
              return yield* new WorkflowNotFoundError({
                workflowID: ctx.params.id,
                message: `no workflow found with id "${ctx.params.id}"`,
              })
            }

            const source = yield* registry.readBody(found.path)
            let runID = ""
            yield* WorkflowEngine.runSource({
              location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }),
              budgetUsd: ctx.payload.budgetUsd ?? null,
              resumeFromRunId: ctx.payload.resumeFromRunId,
              name: found.name,
              onRunID: (id) => {
                runID = id
              },
              source,
              args: ctx.payload.args,
            }).pipe(Effect.ignore)

            // WorkflowEngine.run persists the run's terminal status (completed/failed/cancelled)
            // before it ever settles, so the definitive record always lives in the store --
            // reading it back here is simpler and more honest than trying to reconstruct the
            // same shape from this call site's own success/failure branch.
            const run = yield* registry.getRun(runID)
            if (!run) return yield* Effect.die(new Error(`workflow run ${runID} vanished after completing`))
            return toWorkflowRun(run)
          }),
        )
      }),
    )
    .handle(
      "workflow.run.get",
      Effect.fn(function* (ctx) {
        return yield* response(
          Effect.gen(function* () {
            const registry = yield* WorkflowRegistry.Service
            const run = yield* registry.getRun(ctx.params.runID)
            if (!run) {
              return yield* new WorkflowRunNotFoundError({
                runID: ctx.params.runID,
                message: `no workflow run found with id "${ctx.params.runID}"`,
              })
            }
            return toWorkflowRun(run)
          }),
        )
      }),
    ),
)

function toWorkflowRun(run: WorkflowRunStore.Run) {
  return { id: run.id, status: run.status, result: run.result, error: run.error, resumeOf: run.resumeOf }
}

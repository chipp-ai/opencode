export * as WorkflowEngine from "./engine"

import crypto from "node:crypto"
import os from "node:os"
import { Cause, Effect, Exit } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import type { Location } from "../location"
import type { ModelV2 } from "../model"
import type { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import type { SessionSchema } from "../session/schema"
import { ToolRegistry } from "../tool/registry"
import { WorkflowAgentDispatch } from "./agent-dispatch"
import { WorkflowJournal } from "./journal"
import { WorkflowRunStore } from "./store"

/** A runaway-loop backstop set far above any real workflow -- matches the real Workflow tool's cap. */
const TOTAL_AGENT_CAP = 1000

export type AgentOptions = {
  readonly label?: string
  readonly phase?: string
  readonly model?: ModelV2.Ref
  readonly persona?: string
  readonly permissions?: PermissionV2.Ruleset
  readonly steps?: number
  readonly timeoutMs?: number
  /**
   * A JSON-Schema-shaped object. When set, `agent()` resolves to the captured tool-call
   * arguments instead of the final text -- see WorkflowAgentDispatch.Input.structuredOutput
   * for exactly what guarantee this does (and does not) provide.
   */
  readonly schema?: Record<string, unknown>
}

export type Budget = {
  readonly total: number | null
  readonly spent: () => number
  readonly remaining: () => number
}

export type Context = {
  readonly agent: (prompt: string, opts?: AgentOptions) => Promise<unknown>
  readonly parallel: <T>(thunks: ReadonlyArray<() => Promise<T>>) => Promise<Array<T | null>>
  readonly pipeline: <T>(
    items: ReadonlyArray<T>,
    ...stages: ReadonlyArray<(prev: unknown, item: T, index: number) => Promise<unknown>>
  ) => Promise<unknown[]>
  readonly phase: (title: string) => void
  readonly log: (message: string) => void
  readonly budget: Budget
}

export type RunInput = {
  readonly location: Location.Ref
  /** Attributes every dispatched agent's cost to this session's subtree rollup. */
  readonly parentSessionID?: SessionSchema.ID
  readonly budgetUsd?: number | null
  /** Defaults to min(16, cpus-2), matching the real Workflow tool. */
  readonly concurrency?: number
  readonly defaultPersona?: string
  readonly onPhase?: (title: string) => void
  readonly onLog?: (message: string) => void
  /** Fired once the run row exists, before any dispatch -- capture this to `resumeFromRunId` later. */
  readonly onRunID?: (runID: string) => void
  readonly id?: string
  /** Replays the given run's journal: unchanged `agent()` calls return cached results at zero cost. */
  readonly resumeFromRunId?: string
  readonly name?: string
  readonly run: (ctx: Context) => Promise<unknown>
}

const defaultConcurrency = () => Math.max(1, Math.min(16, os.cpus().length - 2))

class AgentCapExceededError extends Error {
  constructor() {
    super(`Workflow exceeded the ${TOTAL_AGENT_CAP}-agent lifetime cap`)
  }
}

class BudgetExhaustedError extends Error {
  constructor(total: number) {
    super(`Workflow exceeded its $${total.toFixed(2)} budget`)
  }
}

/**
 * Runs one workflow script's `run(ctx)` function. `ctx.agent`/`parallel`/`pipeline` are
 * Promise-returning (matching how plain-JS workflow scripts call them with `await`), bridged
 * to the underlying Effect-based dispatch via a captured Runtime -- the caller's ambient
 * services (AgentV2, SessionV2, Database, etc. for `input.location`) carry through every
 * bridged call.
 *
 * Every call persists a `workflow_run` row (see WorkflowRunStore) with a journal of every live
 * `agent()` call's (prompt, opts) key and result, updated after each call settles. Passing
 * `resumeFromRunId` replays that journal via WorkflowJournal: the unchanged prefix returns
 * cached results at zero additional cost (seeding `budget.spent()` from their recorded cost),
 * and the run diverges to live dispatch from the first changed or new call onward -- see
 * WorkflowJournal's doc comment for the one known ordering caveat inside concurrent
 * `parallel()`/`pipeline()` batches.
 *
 * No worktree isolation, and no cascading cancellation of in-flight dispatches when this Effect
 * is interrupted yet (the run row is correctly marked "cancelled", but a dispatch already bridged
 * through `Effect.runPromiseWith` keeps running to completion) -- see FORK_CHANGES.md.
 */
export const run = Effect.fn("WorkflowEngine.run")(function* (input: RunInput) {
  const context = yield* Effect.context<AgentV2.Service | SessionV2.Service | Database.Service | ToolRegistry.Service>()
  const { db } = yield* Database.Service
  const concurrency = input.concurrency ?? defaultConcurrency()
  const runID = input.id ?? crypto.randomUUID()
  const previousRun = input.resumeFromRunId ? yield* WorkflowRunStore.get(db, input.resumeFromRunId) : undefined
  const replay = WorkflowJournal.makeReplay(previousRun?.journal)

  yield* WorkflowRunStore.create(db, {
    id: runID,
    sessionID: input.parentSessionID,
    directory: input.location.directory,
    name: input.name ?? "workflow",
    resumeOf: input.resumeFromRunId,
  })
  input.onRunID?.(runID)

  const total = input.budgetUsd ?? null
  let spentUsd = replay.cachedCost
  let agentCount = 0

  const dispatchOne = (prompt: string, opts: AgentOptions | undefined) =>
    Effect.gen(function* () {
      const key: WorkflowJournal.Key = { prompt, opts: opts ?? null }
      const cached = replay.check(key)
      if (cached) return opts?.schema ? (cached.structured ?? cached.text) : cached.text

      if (agentCount >= TOTAL_AGENT_CAP) return yield* Effect.die(new AgentCapExceededError())
      if (total !== null && spentUsd >= total) return yield* Effect.die(new BudgetExhaustedError(total))
      agentCount++
      const result = yield* WorkflowAgentDispatch.run({
        location: input.location,
        parentSessionID: input.parentSessionID,
        persona: opts?.persona ?? input.defaultPersona ?? "You are a helpful assistant completing one focused task.",
        permissions: opts?.permissions,
        steps: opts?.steps,
        model: opts?.model,
        timeoutMs: opts?.timeoutMs,
        structuredOutput: opts?.schema ? { schema: opts.schema } : undefined,
        prompt: { text: prompt },
      })
      spentUsd += result.cost
      replay.record(key, {
        sessionID: result.sessionID,
        text: result.text,
        structured: result.structured,
        cost: result.cost,
      })
      // Persisted after every call, not just at the end -- a crash mid-run loses at most the
      // one in-flight call, not the whole run's progress.
      yield* WorkflowRunStore.appendJournal(db, runID, replay.entries())
      return opts?.schema ? (result.structured ?? result.text) : result.text
    })

  const agent: Context["agent"] = (prompt, opts) => Effect.runPromiseWith(context)(dispatchOne(prompt, opts))

  const parallel: Context["parallel"] = (thunks) =>
    Effect.runPromiseWith(context)(
      Effect.forEach(thunks, (thunk) => Effect.tryPromise(thunk).pipe(Effect.catch(() => Effect.succeed(null))), {
        concurrency,
      }),
    )

  const pipeline: Context["pipeline"] = (items, ...stages) =>
    Effect.runPromiseWith(context)(
      Effect.forEach(
        items,
        (item, index) =>
          Effect.gen(function* () {
            let value: unknown
            for (const stage of stages) {
              const next = yield* Effect.tryPromise(() => stage(value, item, index)).pipe(
                Effect.catch(() => Effect.succeed(null)),
              )
              value = next
              if (next === null) break
            }
            return value
          }),
        { concurrency },
      ),
    )

  const phase: Context["phase"] = (title) => input.onPhase?.(title)
  const log: Context["log"] = (message) => input.onLog?.(message)
  const budget: Budget = {
    total,
    spent: () => spentUsd,
    remaining: () => (total === null ? Infinity : Math.max(0, total - spentUsd)),
  }

  const scriptEffect = Effect.tryPromise({
    try: () => input.run({ agent, parallel, pipeline, phase, log, budget }),
    catch: (error) => error,
  })
  const exit = yield* Effect.exit(scriptEffect)
  if (Exit.isSuccess(exit)) {
    yield* WorkflowRunStore.finish(db, runID, { status: "completed", result: exit.value })
    return exit.value
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    yield* WorkflowRunStore.finish(db, runID, { status: "cancelled" })
    return yield* Effect.failCause(exit.cause)
  }
  const error = Cause.squash(exit.cause)
  yield* WorkflowRunStore.finish(db, runID, { status: "failed", error: error instanceof Error ? error.message : String(error) })
  return yield* Effect.fail(error)
})

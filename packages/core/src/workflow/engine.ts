export * as WorkflowEngine from "./engine"

import os from "node:os"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import type { Location } from "../location"
import type { ModelV2 } from "../model"
import type { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import type { SessionSchema } from "../session/schema"
import { ToolRegistry } from "../tool/registry"
import { WorkflowAgentDispatch } from "./agent-dispatch"

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
 * No persistence, pause/resume, or worktree isolation yet -- single in-memory run only
 * (see FORK_CHANGES.md for the phased rollout). `ctx.agent(prompt, {schema})` is supported
 * (see WorkflowAgentDispatch.Input.structuredOutput for its exact, scoped guarantee).
 */
export const run = Effect.fn("WorkflowEngine.run")(function* (input: RunInput) {
  const context = yield* Effect.context<AgentV2.Service | SessionV2.Service | Database.Service | ToolRegistry.Service>()
  const concurrency = input.concurrency ?? defaultConcurrency()
  const total = input.budgetUsd ?? null
  let spentUsd = 0
  let agentCount = 0

  const dispatchOne = (prompt: string, opts: AgentOptions | undefined) =>
    Effect.gen(function* () {
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

  return yield* Effect.tryPromise({ try: () => input.run({ agent, parallel, pipeline, phase, log, budget }), catch: (error) => error })
})

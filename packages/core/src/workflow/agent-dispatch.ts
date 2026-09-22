export * as WorkflowAgentDispatch from "./agent-dispatch"

import type { PromptInput } from "@opencode-ai/schema/prompt-input"
import { Effect, Option } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import { SessionHistory } from "../session/history"
import type { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"

export type Input = {
  readonly location: Location.Ref
  /** Attributes the dispatched session to a parent for the cost rollup (see SessionRollup). */
  readonly parentSessionID?: SessionSchema.ID
  readonly model?: ModelV2.Ref
  /** System prompt for the one-shot agent. */
  readonly persona: string
  /** Tool allow/deny rules for the one-shot agent. Omitted means no restrictions beyond the location's own catalog. */
  readonly permissions?: PermissionV2.Ruleset
  readonly steps?: number
  readonly prompt: PromptInput.Prompt
  /** Interrupts the dispatched session if it hasn't settled within this many milliseconds. */
  readonly timeoutMs?: number
}

export type Result = {
  readonly sessionID: SessionSchema.ID
  readonly text: string
  readonly cost: number
  readonly tokens: SessionMessage.Assistant["tokens"] | undefined
  readonly finish: string | undefined
  readonly error: SessionMessage.UnknownError | undefined
  /** Set when the session was interrupted for exceeding `timeoutMs`. */
  readonly timedOut: boolean
}

let ephemeralAgentCounter = 0
const ephemeralAgentID = () => AgentV2.ID.make(`workflow-dispatch-${Date.now()}-${ephemeralAgentCounter++}`)

const assistantText = (message: SessionMessage.Assistant) =>
  message.content
    .filter((part): part is Extract<SessionMessage.AssistantContent, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")

/**
 * Runs one isolated, one-shot subagent prompt to completion via the V2 session
 * runner and returns its final result. Never bridges through the legacy V1
 * session/prompt loop.
 *
 * Assumes the caller has already established the target Location's scoped
 * context (AgentV2.Service, SessionRunner.Service, etc. -- e.g. via
 * `Effect.provide(locations.get(input.location))`). The engine owns that
 * choice per call, since `isolation: 'worktree'` dispatches need a different
 * Location than the workflow's ambient one; this primitive only needs
 * whichever Location is already active to match `input.location`.
 *
 * Registers a uniquely-ID'd ephemeral AgentV2.Info for the call's
 * persona/tool-scoping/step-cap, scoped to this Effect's own scope -- the
 * registration is released automatically when the scope closes, since
 * AgentV2.Service.transform wires its own disposal into the requesting
 * Scope's finalizers.
 */
export const run = Effect.fn("WorkflowAgentDispatch.run")(function* (input: Input) {
  const agentID = ephemeralAgentID()

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) =>
        draft.update(agentID, (info) => {
          info.system = input.persona
          info.mode = "subagent"
          info.hidden = true
          info.permissions = [...(input.permissions ?? [])]
          info.steps = input.steps
          info.model = input.model
        }),
      )

      const session = yield* SessionV2.Service
      const created = yield* session.create({
        agent: agentID,
        model: input.model,
        location: input.location,
        parentID: input.parentSessionID,
      })

      yield* session.prompt({ sessionID: created.id, prompt: input.prompt })

      const settled = yield* session
        .wait(created.id)
        .pipe(input.timeoutMs !== undefined ? Effect.timeoutOption(input.timeoutMs) : Effect.map(Option.some))
      const timedOut = Option.isNone(settled)
      if (timedOut) yield* session.interrupt(created.id)

      const { db } = yield* Database.Service
      const last = yield* SessionHistory.lastAssistant(db, created.id)

      return {
        sessionID: created.id,
        text: last ? assistantText(last) : "",
        cost: last?.cost ?? 0,
        tokens: last?.tokens,
        finish: last?.finish,
        error: last?.error,
        timedOut,
      } satisfies Result
    }),
  )
})

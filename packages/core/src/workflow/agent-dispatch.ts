export * as WorkflowAgentDispatch from "./agent-dispatch"

import { JsonSchemaValidator } from "@opencode-ai/llm"
import type { PromptInput } from "@opencode-ai/schema/prompt-input"
import { Deferred, Effect, Option, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import { SessionHistory } from "../session/history"
import type { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { Tool } from "../tool/tool"
import { ToolRegistry } from "../tool/registry"

export type StructuredOutputInput = {
  /** A JSON-Schema-shaped object (`{type: "object", properties: {...}, required: [...]}`). */
  readonly schema: Record<string, unknown>
}

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
  /**
   * Forces the final answer through a dedicated tool call instead of plain text.
   *
   * Deliberately does not touch the shared V2 runner's per-turn request construction
   * (no `toolChoice: "required"` at the LLM.request level, unlike the legacy V1
   * implementation) -- that logic runs for every session in the process, not just
   * workflow dispatches, and forcing tool choice there would need to be threaded
   * through the durable Prompt schema and change behavior for ordinary chat turns.
   * Instead: a strong system-prompt nudge plus an ephemeral tool whose call is
   * raced against session settlement -- whichever resolves first wins, and a
   * structured-tool win immediately interrupts the session so it doesn't keep
   * stepping. The tool's arguments are validated against `schema` with
   * `JsonSchemaValidator`; a schema-violating call is rejected back to the model
   * as an ordinary tool error (like any typed tool-input decode failure), so it
   * can retry, and nothing is captured. The exact schema is advertised to the
   * model only via the system nudge and tool description text -- the tool's
   * generated input schema is still a plain key-value record.
   */
  readonly structuredOutput?: StructuredOutputInput
}

export type Result = {
  readonly sessionID: SessionSchema.ID
  readonly text: string
  readonly structured?: Record<string, unknown>
  readonly cost: number
  readonly tokens: SessionMessage.Assistant["tokens"] | undefined
  readonly finish: string | undefined
  readonly error: SessionMessage.AssistantError | undefined
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

const structuredOutputNudge = (schema: Record<string, unknown>) =>
  [
    "",
    "IMPORTANT: You MUST call the StructuredOutput tool as your final action, with arguments",
    "matching this JSON schema exactly. Do not respond with plain text.",
    "",
    JSON.stringify(schema, null, 2),
  ].join("\n")

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
 * Scope's finalizers. The ephemeral StructuredOutput tool (when requested)
 * is released the same way via ToolRegistry.Service.register's own scoped
 * disposal.
 */
export const run = Effect.fn("WorkflowAgentDispatch.run")(function* (input: Input) {
  const agentID = ephemeralAgentID()

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const persona = input.structuredOutput
        ? input.persona + structuredOutputNudge(input.structuredOutput.schema)
        : input.persona
      yield* agents.transform((draft) =>
        draft.update(agentID, (info) => {
          info.system = persona
          info.mode = "subagent"
          info.hidden = true
          info.permissions = [...(input.permissions ?? [])]
          info.steps = input.steps
          info.model = input.model
        }),
      )

      const captured = input.structuredOutput
        ? yield* Deferred.make<Record<string, unknown>>()
        : undefined
      if (input.structuredOutput && captured) {
        const tools = yield* ToolRegistry.Service
        yield* tools.register({
          StructuredOutput: Tool.make({
            description: [
              "Provide your final answer by calling this tool exactly once. Arguments MUST match",
              "this JSON schema:",
              "",
              JSON.stringify(input.structuredOutput.schema, null, 2),
            ].join("\n"),
            input: Schema.Record(Schema.String, Schema.Unknown).check(
              JsonSchemaValidator.check(input.structuredOutput.schema),
            ),
            output: Schema.Struct({ ok: Schema.Boolean }),
            execute: (args) => Deferred.succeed(captured, args).pipe(Effect.as({ ok: true })),
            toModelOutput: () => [{ type: "text", text: "Structured output captured." }],
          }),
        })
      }

      const session = yield* SessionV2.Service
      const created = yield* session.create({
        agent: agentID,
        model: input.model,
        location: input.location,
        parentID: input.parentSessionID,
      })

      yield* session.prompt({ sessionID: created.id, prompt: input.prompt })

      const winner = yield* Effect.raceAll([
        session.wait(created.id).pipe(Effect.as("settled" as const)),
        ...(captured ? [Deferred.await(captured).pipe(Effect.as("structured" as const))] : []),
        ...(input.timeoutMs !== undefined ? [Effect.sleep(input.timeoutMs).pipe(Effect.as("timeout" as const))] : []),
      ])
      // Both "structured" (stop stepping once the final answer is captured) and
      // "timeout" require stopping a still-in-flight session; "settled" already
      // means the coordinator's drain is done, so interrupting it is a no-op.
      if (winner !== "settled") yield* session.interrupt(created.id)

      const { db } = yield* Database.Service
      const last = yield* SessionHistory.lastAssistant(db, created.id)
      // Poll rather than trust `winner`: a natural settlement can race a tool call that
      // landed moments earlier, so check for a captured value regardless of which branch won.
      const structuredExit = captured ? yield* Deferred.poll(captured) : undefined
      const structured = structuredExit && Option.isSome(structuredExit) ? yield* structuredExit.value : undefined

      return {
        sessionID: created.id,
        text: last ? assistantText(last) : "",
        structured,
        cost: last?.cost ?? 0,
        tokens: last?.tokens,
        finish: last?.finish,
        error: last?.error,
        timedOut: winner === "timeout",
      } satisfies Result
    }),
  )
})

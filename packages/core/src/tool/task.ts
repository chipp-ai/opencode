export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { SessionDispatchPort } from "../session/dispatch-port"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { WorkflowAgentDispatch } from "../workflow/agent-dispatch"

// Depends on `SessionDispatchPort` rather than `../session`'s `SessionV2` directly: see that
// module's own doc comment for why a direct import here would close a real dependency cycle
// between session orchestration and the Location/tool bootstrap this tool composes into.
export const name = "task"

// Matches V1's default (`packages/opencode/src/config/config.ts`'s `subagent_depth`) so a
// subagent that itself has task access can't recurse indefinitely by default.
const MAX_SUBAGENT_DEPTH = 1

export const Input = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description:
      'Override the subagent model for this invocation only (format: "provider/model-id", e.g. "anthropic/claude-sonnet-4"). Takes priority over the subagent\'s configured model. Requires the model_override permission.',
  }),
  variant: Schema.String.pipe(Schema.optional).annotate({
    description: 'Model variant (model-specific reasoning/effort preset, e.g. "high") for this invocation only.',
  }),
})

const Output = Schema.Struct({
  sessionID: Schema.String,
  text: Schema.String,
  timedOut: Schema.Boolean,
})
type Output = typeof Output.Type

function parseModelOverride(input: string) {
  const pattern = input.trim()
  const slash = pattern.indexOf("/")
  if (slash <= 0 || slash === pattern.length - 1)
    return Effect.fail(new ToolFailure({ message: `Invalid model format: "${input}". Expected "provider/model-id".` }))
  const parsed = ModelV2.parse(pattern)
  return Effect.succeed({ pattern, ref: { id: parsed.modelID, providerID: parsed.providerID } })
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentV2.Service
    const permission = yield* PermissionV2.Service
    const sessions = yield* SessionDispatchPort.Service
    const location = yield* Location.Service
    const registry = yield* ToolRegistry.Service
    const database = yield* Database.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Launch an isolated subagent to work on a task and report back its final answer. Use `subagent_type` " +
            "to pick which configured agent persona runs it. Optionally override its model (`model`, format " +
            '"provider/model-id") or variant for this call only.',
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: `<task id="${output.sessionID}">\n${output.text}\n</task>` },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = { type: "tool" as const, messageID: context.assistantMessageID, callID: context.toolCallID }

              const getSession = (id: typeof context.sessionID) =>
                sessions.get(id).pipe(Effect.mapError((error) => new ToolFailure({ message: errorMessage(error) })))
              let depth = 0
              let current = yield* getSession(context.sessionID)
              while (current.parentID) {
                depth++
                current = yield* getSession(current.parentID)
              }
              if (depth >= MAX_SUBAGENT_DEPTH)
                return yield* Effect.fail(
                  new ToolFailure({ message: `Subagent depth limit reached (${MAX_SUBAGENT_DEPTH}).` }),
                )

              const overrideModel = input.model === undefined ? undefined : yield* parseModelOverride(input.model)
              if (overrideModel)
                yield* permission
                  .assert({
                    action: "model_override",
                    resources: [overrideModel.pattern],
                    save: [overrideModel.pattern],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: errorMessage(error) })))

              yield* permission
                .assert({
                  action: name,
                  resources: [input.subagent_type],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: errorMessage(error) })))

              const target = yield* agents.get(AgentV2.ID.make(input.subagent_type))
              if (!target)
                return yield* Effect.fail(new ToolFailure({ message: `Unknown agent type: ${input.subagent_type}` }))

              const model = overrideModel?.ref ?? target.model
              // Dynamic import: `WorkflowAgentDispatch.run` requires `SessionV2.Service` itself
              // (statically imported inside `agent-dispatch.ts`, which is fine there since that
              // file never joins the Location/tool bootstrap). Getting the *tag* here via a
              // dynamic import -- purely to name it as the `Effect.provideService` target below --
              // avoids reintroducing a static `../session` import into this file, which is what
              // `SessionDispatchPort` exists to prevent. The value provided is the real port
              // instance from this tool's own `deps` (`sessions`); the cast only widens its type
              // back to `SessionV2.Interface`'s shape, since it already matches at runtime -- the
              // composition root (`packages/opencode/.../server.ts`) supplies the real
              // `SessionV2.Service` as this port's implementation in the first place.
              const { SessionV2 } = yield* Effect.promise(() => import("../session"))
              const result = yield* WorkflowAgentDispatch.run({
                location: { directory: location.directory, workspaceID: location.workspaceID },
                parentSessionID: context.sessionID,
                model: input.variant && model ? { ...model, variant: ModelV2.VariantID.make(input.variant) } : model,
                persona: target.system ?? "",
                permissions: target.permissions,
                steps: target.steps,
                prompt: { text: input.prompt },
              }).pipe(
                Effect.provideService(AgentV2.Service, agents),
                Effect.provideService(SessionV2.Service, sessions as unknown as InstanceType<typeof SessionV2.Service>),
                Effect.provideService(Database.Service, database),
                Effect.provideService(ToolRegistry.Service, registry),
                Effect.mapError((error) => new ToolFailure({ message: errorMessage(error) })),
              )

              if (result.error)
                return yield* Effect.fail(
                  new ToolFailure({ message: `Subagent failed (session: ${result.sessionID}): ${result.error.message}` }),
                )

              return { sessionID: result.sessionID, text: result.text, timedOut: result.timedOut } satisfies Output
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/task",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, AgentV2.node, Location.node, SessionDispatchPort.node, Database.node],
})

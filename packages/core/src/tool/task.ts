export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { WorkflowAgentDispatch } from "../workflow/agent-dispatch"

// This tool is NOT part of `packages/core/src/tool/builtins.ts`/`location-services.ts`'s own
// bundle, unlike the other built-in tools: `SessionV2.Service` (used by `WorkflowAgentDispatch`)
// itself depends, through `location-service-map.ts`, on the same location bootstrap that
// `location-services.ts` composes -- a tool living inside that bundle that also needs to create
// and orchestrate sessions would close a real dependency cycle, not just a TypeScript one.
// Instead this node is composed directly alongside `SessionV2.node` at the server's own top-level
// composition (`packages/opencode/src/server/routes/instance/httpapi/server.ts`), the same place
// that already builds `SessionV2.node` as a peer of `location-services.ts`'s bundle rather than a
// dependency of it. It still registers into the same Location-scoped `Tools.Service`/
// `ToolRegistry.Service` singleton that `location-services.ts` builds, so it appears in the tool
// catalog exactly like any other built-in once both are composed together.
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

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentV2.Service
    const permission = yield* PermissionV2.Service
    const sessions = yield* SessionV2.Service
    const location = yield* Location.Service
    const database = yield* Database.Service
    const registry = yield* ToolRegistry.Service

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
                sessions.get(id).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))
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
                  .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))

              yield* permission
                .assert({
                  action: name,
                  resources: [input.subagent_type],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))

              const target = yield* agents.get(AgentV2.ID.make(input.subagent_type))
              if (!target)
                return yield* Effect.fail(new ToolFailure({ message: `Unknown agent type: ${input.subagent_type}` }))

              const model = overrideModel?.ref ?? target.model
              const result = yield* WorkflowAgentDispatch.run({
                location: { directory: location.directory, workspaceID: location.workspaceID },
                parentSessionID: context.sessionID,
                model: input.variant && model ? { ...model, variant: ModelV2.VariantID.make(input.variant) } : model,
                persona: target.system ?? "",
                permissions: target.permissions,
                steps: target.steps,
                prompt: { text: input.prompt },
              }).pipe(
                // `WorkflowAgentDispatch.run` requires these services itself; this tool's own
                // `deps` already guarantee they exist in the ambient Location context, so this
                // just re-threads the already-resolved instances rather than re-yielding them.
                Effect.provideService(AgentV2.Service, agents),
                Effect.provideService(SessionV2.Service, sessions),
                Effect.provideService(Database.Service, database),
                Effect.provideService(ToolRegistry.Service, registry),
                Effect.mapError((error) => new ToolFailure({ message: error.message })),
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
  deps: [ToolRegistry.node, PermissionV2.node, AgentV2.node, Location.node, SessionV2.node, Database.node],
})

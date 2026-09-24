import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, Usage, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Layer, Stream } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SystemContext } from "@opencode-ai/core/system-context/index"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WorkflowAgentDispatch } from "@opencode-ai/core/workflow/agent-dispatch"
import { testEffect } from "./lib/effect"

let response: LLMEvent[] = []
// Per-turn responses consumed before falling back to `response`, for multi-turn scenarios.
let turns: LLMEvent[][] = []
let requests: LLMRequest[] = []
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(turns.shift() ?? response)
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() =>
  Effect.succeed({ model, info: ModelV2.Info.empty(ProviderV2.ID.make("fake"), ModelV2.ID.make("fake-model")) }),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({ buffer: 3_000, keep: new ConfigCompaction.Keep({ tokens: 1_000 }) }),
          }),
        }),
      ]),
  }),
)
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
      join: coordinator.join,
    })
  }),
).pipe(Layer.provide(runnerLayer))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [
        ProjectV2.node,
        Layer.succeed(
          ProjectV2.Service,
          ProjectV2.Service.of({
            resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
            directories: () => Effect.succeed([]),
            commit: () => Effect.void,
          }),
        ),
      ],
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const okResponse = () =>
  ([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text: "the answer is 42" },
    { type: "text-end", id: "t1" },
    {
      type: "step-finish",
      index: 0,
      reason: "stop",
      usage: new Usage({ inputTokens: 100, outputTokens: 10, nonCachedInputTokens: 100 }),
    },
    { type: "finish", reason: "stop" },
  ] as unknown) as LLMEvent[]

describe("WorkflowAgentDispatch.run", () => {
  it.effect("dispatches an isolated one-shot agent and returns its final text/cost/tokens", () =>
    Effect.gen(function* () {
      response = okResponse()

      const result = yield* WorkflowAgentDispatch.run({
        location,
        persona: "You are a helpful test agent.",
        prompt: { text: "what is the answer?" },
      })

      expect(result.text).toBe("the answer is 42")
      expect(result.finish).toBe("stop")
      expect(result.timedOut).toBe(false)
      expect(result.tokens?.input).toBe(100)
      expect(result.tokens?.output).toBe(10)
    }),
  )

  it.effect("attributes the dispatched session to the given parent", () =>
    Effect.gen(function* () {
      response = okResponse()
      const session = yield* SessionV2.Service
      const root = yield* session.create({ location })

      const result = yield* WorkflowAgentDispatch.run({
        location,
        parentSessionID: root.id,
        persona: "test",
        prompt: { text: "hi" },
      })

      const created = yield* session.get(result.sessionID)
      expect(created.parentID).toBe(root.id)
    }),
  )

  it.effect("removes the ephemeral agent registration once the dispatch scope closes", () =>
    Effect.gen(function* () {
      response = okResponse()
      const session = yield* SessionV2.Service

      const result = yield* WorkflowAgentDispatch.run({ location, persona: "test", prompt: { text: "hi" } })
      const created = yield* session.get(result.sessionID)
      expect(created.agent).toBeDefined()

      const agents = yield* AgentV2.Service
      expect(yield* agents.get(created.agent!)).toBeUndefined()
    }),
  )

  it.effect("captures a StructuredOutput tool call and stops before further steps", () =>
    Effect.gen(function* () {
      response = ([
        { type: "tool-call", id: "call_1", name: "StructuredOutput", input: { answer: 42 } },
        { type: "step-finish", index: 0, reason: "tool-calls", usage: new Usage({ inputTokens: 1, outputTokens: 1 }) },
        { type: "finish", reason: "tool-calls" },
      ] as unknown) as LLMEvent[]

      const result = yield* WorkflowAgentDispatch.run({
        location,
        persona: "You are a helpful test agent.",
        prompt: { text: "what is the answer?" },
        structuredOutput: { schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } },
      })

      expect(result.structured).toEqual({ answer: 42 })
      expect(result.timedOut).toBe(false)
    }),
  )

  it.effect("rejects a StructuredOutput call that violates the schema so the model can retry", () =>
    Effect.gen(function* () {
      requests = []
      const structuredCall = (id: string, input: unknown) =>
        ([
          { type: "tool-call", id, name: "StructuredOutput", input },
          { type: "step-finish", index: 0, reason: "tool-calls", usage: new Usage({ inputTokens: 1, outputTokens: 1 }) },
          { type: "finish", reason: "tool-calls" },
        ] as unknown) as LLMEvent[]
      turns = [structuredCall("call_bad", { answer: "forty-two", extra: true }), structuredCall("call_ok", { answer: 42 })]
      response = okResponse()

      const result = yield* WorkflowAgentDispatch.run({
        location,
        persona: "You are a helpful test agent.",
        prompt: { text: "what is the answer?" },
        structuredOutput: {
          schema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      })

      expect(result.structured).toEqual({ answer: 42 })
      expect(requests).toHaveLength(2)
      const rejection = requests[1]?.messages
        .flatMap((message) => message.content)
        .find((part) => part.type === "tool-result" && part.id === "call_bad")
      expect(rejection).toMatchObject({
        type: "tool-result",
        result: {
          type: "error",
          value: {
            error: {
              message: 'Invalid tool input: is not an allowed property\n  at ["extra"]\nmust be number\n  at ["answer"]',
            },
          },
        },
      })
    }),
  )

  it.effect("captures nothing when every StructuredOutput call violates the schema", () =>
    Effect.gen(function* () {
      turns = []
      response = ([
        { type: "tool-call", id: "call_bad", name: "StructuredOutput", input: { wrong: true } },
        { type: "step-finish", index: 0, reason: "tool-calls", usage: new Usage({ inputTokens: 1, outputTokens: 1 }) },
        { type: "finish", reason: "tool-calls" },
      ] as unknown) as LLMEvent[]

      const result = yield* WorkflowAgentDispatch.run({
        location,
        persona: "test",
        prompt: { text: "hi" },
        steps: 2,
        structuredOutput: { schema: { type: "object", required: ["answer"] } },
      })

      expect(result.structured).toBeUndefined()
      expect(result.timedOut).toBe(false)
    }),
  )

  it.effect("does not register a StructuredOutput tool when no schema is requested", () =>
    Effect.gen(function* () {
      response = okResponse()
      const result = yield* WorkflowAgentDispatch.run({ location, persona: "test", prompt: { text: "hi" } })
      expect(result.structured).toBeUndefined()
    }),
  )
})

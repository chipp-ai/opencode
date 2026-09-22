import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, Usage, type LLMClientShape } from "@opencode-ai/llm"
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
import { WorkflowEngine } from "@opencode-ai/core/workflow/engine"
import { testEffect } from "./lib/effect"

let response: LLMEvent[] = []
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (() => Stream.fromIterable(response)) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
// Nonzero rate: $1/M input + $1/M output tokens, so budget enforcement has something to spend.
const pricedInfo = {
  ...ModelV2.Info.empty(ProviderV2.ID.make("fake"), ModelV2.ID.make("fake-model")),
  cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
}
const models = SessionRunnerModel.layerWith(() => Effect.succeed({ model, info: pricedInfo }))
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

const reply = (text: string) =>
  ([
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", text },
    { type: "text-end", id: "t1" },
    { type: "step-finish", index: 0, reason: "stop", usage: new Usage({ inputTokens: 100, outputTokens: 100 }) },
    { type: "finish", reason: "stop" },
  ] as unknown) as LLMEvent[]

describe("WorkflowEngine.run", () => {
  it.effect("runs a script's ctx.agent call and returns its result", () =>
    Effect.gen(function* () {
      response = reply("42")
      const result = yield* WorkflowEngine.run({
        location,
        run: async (ctx) => ctx.agent("what is the answer?"),
      })
      expect(result).toBe("42")
    }),
  )

  it.effect("invokes onPhase/onLog for ctx.phase/ctx.log", () =>
    Effect.gen(function* () {
      response = reply("ok")
      const phases: string[] = []
      const logs: string[] = []
      yield* WorkflowEngine.run({
        location,
        onPhase: (title) => phases.push(title),
        onLog: (message) => logs.push(message),
        run: async (ctx) => {
          ctx.phase("Research")
          ctx.log("starting")
          await ctx.agent("go")
        },
      })
      expect(phases).toEqual(["Research"])
      expect(logs).toEqual(["starting"])
    }),
  )

  it.effect("parallel runs thunks concurrently, nulling a rejected one", () =>
    Effect.gen(function* () {
      response = reply("a")
      const results = yield* WorkflowEngine.run({
        location,
        run: async (ctx) =>
          ctx.parallel([() => ctx.agent("one"), () => Promise.reject(new Error("boom")), () => ctx.agent("three")]),
      })
      expect(results).toEqual(["a", null, "a"])
    }),
  )

  it.effect("pipeline threads each item through every stage independently", () =>
    Effect.gen(function* () {
      const results = yield* WorkflowEngine.run({
        location,
        run: async (ctx) =>
          ctx.pipeline(
            [1, 2, 3],
            async (_prev, item) => item * 10,
            async (prev, item, index) => `${prev}-${item}-${index}`,
          ),
      })
      expect(results).toEqual(["10-1-0", "20-2-1", "30-3-2"])
    }),
  )

  it.effect("stops a stage chain early when a stage rejects", () =>
    Effect.gen(function* () {
      const results = yield* WorkflowEngine.run({
        location,
        run: async (ctx) =>
          ctx.pipeline(
            [1],
            async () => Promise.reject(new Error("stage failed")),
            async (prev) => `unreachable-${prev}`,
          ),
      })
      expect(results).toEqual([null])
    }),
  )

  it.effect("budget.spent reflects real dispatch cost and blocks further agent calls once exhausted", () =>
    Effect.gen(function* () {
      // Round dollar amounts avoid floating-point boundary flakiness in the >= check.
      // nonCachedInputTokens omitted -> input contributes 0; only the 1M visible output
      // tokens price, at $1/M, so each dispatch costs exactly $1.
      response = ([
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", text: "hi" },
        { type: "text-end", id: "t1" },
        {
          type: "step-finish",
          index: 0,
          reason: "stop",
          usage: new Usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
        },
        { type: "finish", reason: "stop" },
      ] as unknown) as LLMEvent[]
      let spentDuringRun = 0
      const error = yield* Effect.flip(
        WorkflowEngine.run({
          location,
          budgetUsd: 1,
          run: async (ctx) => {
            await ctx.agent("first")
            spentDuringRun = ctx.budget.spent()
            return ctx.agent("second")
          },
        }),
      )
      expect(spentDuringRun).toBe(1)
      expect(String(error)).toContain("budget")
    }),
  )
})

import { describe, expect } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  TransportReason,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, type LocationError, type LocationServices } from "@opencode-ai/core/location-services"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { eq } from "drizzle-orm"
import { Deferred, Duration, Effect, Fiber, Layer, LayerMap, Schema, Scope, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make("/project")
const requests: LLMRequest[] = []
let responses: LLMEvent[][] = []
let toolGate: Deferred.Deferred<void> | undefined
// Artificial provider latency before a turn's events (or failure) are delivered.
let streamDelay = Duration.zero
let streamFailure: LLMError | undefined
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      const events = streamFailure ? Stream.fail(streamFailure) : Stream.fromIterable(responses.shift() ?? [])
      return Stream.unwrap(Effect.sleep(streamDelay).pipe(Effect.as(events)))
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
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }) => (toolGate ? Deferred.await(toolGate) : Effect.void).pipe(Effect.as({ text })),
      }),
    }),
  ),
)
const echoNode = makeLocationNode({ name: "test/session-status-tools", layer: echo, deps: [ToolRegistry.node] })
const systemContext = AppNodeBuilder.build(SystemContextRegistry.node)
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
// Serve the harness's own runner for every Location so the production execution layer's status events and the
// runner's transcript events share one EventV2 instance.
const locationServiceMap = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const shared = yield* Effect.context<SessionRunner.Service>()
    return yield* LayerMap.make(() => Layer.succeedContext(shared))
  }) as unknown as Effect.Effect<
    LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>,
    never,
    Scope.Scope | SessionRunner.Service
  >,
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      echoNode,
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
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [Config.node, config],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [SessionExecution.node, SessionExecutionLocal.node],
      [LocationServiceMap.node, locationServiceMap],
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_status_event")

const setup = Effect.gen(function* () {
  requests.length = 0
  responses = []
  toolGate = undefined
  streamDelay = Duration.zero
  streamFailure = undefined
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: sessionID, directory, title: "status", version: "test" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return yield* SessionV2.Service
})

const toolCallStep = [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]
const textStep = (text: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id: "text-final" }),
  LLMEvent.textDelta({ id: "text-final", text }),
  LLMEvent.textEnd({ id: "text-final" }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

// Records the Session's live event types in publish order, keeping only status and step boundaries.
const recordTimeline = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const timeline: string[] = []
  const isStatus = Schema.is(SessionEvent.StatusChanged.data)
  const unsubscribe = yield* events.listen((event) =>
    Effect.sync(() => {
      if (event.type === SessionEvent.StatusChanged.type && isStatus(event.data) && event.data.sessionID === sessionID)
        timeline.push(`status:${event.data.status}`)
      if (event.type === SessionEvent.Step.Started.type) timeline.push("step.started")
      if (event.type === SessionEvent.Step.Ended.type) timeline.push("step.ended")
    }),
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  return timeline
})

describe("SessionExecutionLocal status events", () => {
  it.live("publishes busy once before a multi-step tool turn and idle once after it settles", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const timeline = yield* recordTimeline
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })
      responses = [toolCallStep, textStep("Done")]

      // `resume` returns only after onIdle, so the timeline is already complete here.
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(timeline).toEqual([
        "status:busy",
        "step.started",
        "step.ended",
        "step.started",
        "step.ended",
        "status:idle",
      ])
    }),
  )

  it.live("reports busy while a tool is still running and the session is in the active set", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const timeline = yield* recordTimeline
      const execution = yield* SessionExecution.Service
      toolGate = yield* Deferred.make<void>()
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo slowly" }), resume: false })
      responses = [toolCallStep, textStep("Done")]

      yield* execution.wake(sessionID)
      while (!timeline.includes("step.started")) yield* Effect.yieldNow

      expect(timeline).toEqual(["status:busy", "step.started"])
      expect(Array.from(yield* execution.active)).toEqual([sessionID])

      yield* Deferred.succeed(toolGate, undefined)
      yield* execution.join(sessionID)
      expect(timeline.filter((item) => item.startsWith("status:"))).toEqual(["status:busy", "status:idle"])
      expect(Array.from(yield* execution.active)).toEqual([])
    }),
  )

  it.live("keeps the status event out of the durable event log", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const timeline = yield* recordTimeline
      const events = yield* EventV2.Service
      const live = yield* events
        .subscribe(SessionEvent.StatusChanged)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hi" }), resume: false })
      responses = [textStep("Hello")]

      yield* session.resume(sessionID)

      const delivered = Array.from(yield* Fiber.join(live))
      expect(delivered.map((event) => [event.data.status, event.durable, event.location?.directory])).toEqual([
        ["busy", undefined, directory],
        ["idle", undefined, directory],
      ])
      const database = yield* Database.Service
      const rows = yield* database.db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.StatusChanged.type, 1)))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(0)
      expect(SessionEvent.DurableDefinitions).not.toContain(SessionEvent.StatusChanged)
      expect(SessionEvent.Definitions).toContain(SessionEvent.StatusChanged)
    }),
  )
})

describe("SessionV2.resumeDetached", () => {
  it.live("returns before a slow model turn, which still completes afterward", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const timeline = yield* recordTimeline
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Take your time" }), resume: false })
      responses = [textStep("Finally")]
      streamDelay = Duration.millis(500)

      const started = Date.now()
      yield* session.resumeDetached(sessionID)

      expect(Date.now() - started).toBeLessThan(250)
      expect(Array.from(yield* session.active)).toEqual([sessionID])
      expect(yield* session.context(sessionID)).toMatchObject([{ type: "user", text: "Take your time" }])

      // The drain is registered before resumeDetached returns, so `wait` joins it rather than returning early.
      yield* session.wait(sessionID)
      expect(Date.now() - started).toBeGreaterThanOrEqual(500)
      expect(requests).toHaveLength(1)
      expect(timeline).toEqual(["status:busy", "step.started", "step.ended", "status:idle"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Take your time" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Finally" }] },
      ])
    }),
  )

  it.live("keeps a failed turn from the caller while the execution owner logs it", () =>
    Effect.gen(function* () {
      const session = yield* setup
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "This will fail" }), resume: false })
      streamFailure = new LLMError({
        module: "test",
        method: "stream",
        reason: new TransportReason({ message: "Provider unavailable" }),
      })
      streamDelay = Duration.millis(200)

      const started = Date.now()
      const exit = yield* session.resumeDetached(sessionID).pipe(Effect.exit)
      expect(Date.now() - started).toBeLessThan(100)
      expect(exit._tag).toBe("Success")

      // `wait` joins the same drain, so it observes the failure that resumeDetached's caller never sees.
      expect(yield* session.wait(sessionID).pipe(Effect.flip)).toBe(streamFailure)
      expect(requests).toHaveLength(1)
      const logged = [...(yield* TestConsole.logLines), ...(yield* TestConsole.errorLines)].map(String).join("\n")
      expect(logged).toContain("Failed to drain Session")
      expect(logged).toContain("Provider unavailable")
    }),
  )

  it.live("fails only for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* setup
      const error = yield* session.resumeDetached(SessionV2.ID.make("ses_missing_detached")).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionV2.NotFoundError)
      expect(requests).toHaveLength(0)
    }),
  )
})

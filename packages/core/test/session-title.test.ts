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
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
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
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { DateTime, Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const TITLE_SYSTEM = "You are a title generator."

// Title-agent requests are recognized by their system prompt, so main turns and title calls are scripted separately.
const isTitleRequest = (request: LLMRequest) => request.system.some((part) => part.text === TITLE_SYSTEM)
const turnRequests: LLMRequest[] = []
const titleRequests: LLMRequest[] = []
let titleReply: Stream.Stream<LLMEvent, LLMError> = Stream.empty
let turnReplies: LLMEvent[][] = []
const reply = (id: string, text: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      if (isTitleRequest(request)) {
        titleRequests.push(request)
        return titleReply
      }
      turnRequests.push(request)
      return Stream.fromIterable(turnReplies.shift() ?? reply("answer", "Sure, here is the answer."))
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() =>
  Effect.succeed({
    model,
    info: ModelV2.Info.empty(ProviderV2.ID.make("fake"), ModelV2.ID.make("fake-model")),
  }),
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
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const overrides = [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
] as const
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [...overrides])
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
    [...overrides, [SessionExecution.node, execution]],
  ),
)

const sessionID = SessionV2.ID.make("ses_title_test")
const parentID = SessionV2.ID.make("ses_title_parent")

const setup = (input: { title?: string; parentID?: SessionV2.ID } = {}) =>
  Effect.gen(function* () {
    turnRequests.length = 0
    titleRequests.length = 0
    turnReplies = []
    titleReply = Stream.fromIterable(reply("title", "Fix login redirect"))
    const agents = yield* AgentV2.Service
    // Mirrors the hidden `title` agent the built-in agent plugin registers.
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("title"), (agent) => {
        agent.mode = "primary"
        agent.hidden = true
        agent.system = TITLE_SYSTEM
      }),
    )
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        parent_id: input.parentID,
        slug: sessionID,
        directory: "/project",
        title: input.title ?? SessionTitle.placeholder(Date.now()),
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return yield* SessionV2.Service
  })

const promptAndWait = (session: SessionV2.Interface, text: string) =>
  Effect.gen(function* () {
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text }) })
    yield* session.wait(sessionID)
  })

// Negative cases have no event to await, so give any detached title fiber a chance to run before asserting.
const settle = Effect.sleep("50 millis")

describe("SessionV2 auto-title", () => {
  it.live("generates a title from the first real user message", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      const events = yield* EventV2.Service
      const changed = yield* events
        .subscribe(SessionEvent.TitleChanged)
        .pipe(Stream.runHead, Effect.forkScoped)

      yield* promptAndWait(session, "The login page redirects to a 404")
      const event = yield* Fiber.join(changed)

      expect(event._tag === "Some" && event.value.data.title).toBe("Fix login redirect")
      expect((yield* session.get(sessionID)).title).toBe("Fix login redirect")
      expect(titleRequests).toHaveLength(1)
      expect(titleRequests[0]?.tools).toEqual([])
      expect(
        titleRequests[0]?.messages.flatMap((message) =>
          message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])),
        ),
      ).toEqual(["Generate a title for this conversation:\n", "The login page redirects to a 404"])
      const history = yield* session.history({ sessionID, limit: 100 })
      expect(history.events.filter((item) => item.type === "session.next.title.changed")).toHaveLength(1)
    }),
  )

  it.live("strips think blocks and truncates long titles to 100 characters", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      titleReply = Stream.fromIterable(reply("title", `<think>pondering</think>\n\n  ${"a".repeat(150)}  \nsecond`))
      const events = yield* EventV2.Service
      const changed = yield* events
        .subscribe(SessionEvent.TitleChanged)
        .pipe(Stream.runHead, Effect.forkScoped)

      yield* promptAndWait(session, "Hello")
      yield* Fiber.join(changed)

      expect((yield* session.get(sessionID)).title).toBe(`${"a".repeat(97)}...`)
    }),
  )

  it.live("skips subagent sessions", () =>
    Effect.gen(function* () {
      const session = yield* setup({ parentID })

      yield* promptAndWait(session, "Explore the repo")
      yield* settle

      expect(turnRequests).toHaveLength(1)
      expect(titleRequests).toHaveLength(0)
      expect(SessionTitle.isDefault((yield* session.get(sessionID)).title)).toBe(true)
    }),
  )

  it.live("leaves customized titles alone", () =>
    Effect.gen(function* () {
      const session = yield* setup({ title: "My custom title" })

      yield* promptAndWait(session, "Hello")
      yield* settle

      expect(turnRequests).toHaveLength(1)
      expect(titleRequests).toHaveLength(0)
      expect((yield* session.get(sessionID)).title).toBe("My custom title")
    }),
  )

  it.live("does not retitle on a later turn", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      // A generation that yields no usable line keeps the placeholder, so a later turn is the only way to retitle.
      titleReply = Stream.fromIterable(reply("title", "   \n  "))

      yield* promptAndWait(session, "First question")
      yield* settle
      yield* promptAndWait(session, "Second question")
      yield* settle

      expect(turnRequests).toHaveLength(2)
      expect(titleRequests).toHaveLength(1)
      expect(SessionTitle.isDefault((yield* session.get(sessionID)).title)).toBe(true)
    }),
  )

  it.live("does not retitle on tool-continuation steps of the first turn", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      titleReply = Stream.fromIterable(reply("title", "   "))
      turnReplies = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing", name: "missing_tool", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      yield* promptAndWait(session, "Use a tool")
      yield* settle

      expect(turnRequests).toHaveLength(2)
      expect(titleRequests).toHaveLength(1)
    }),
  )

  it.live("keeps the prompt turn successful when title generation fails", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      titleReply = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new TransportReason({ message: "Title provider unavailable" }),
        }),
      )

      yield* promptAndWait(session, "Hello")
      yield* settle

      expect(titleRequests).toHaveLength(1)
      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])
      expect(messages[1]?.type === "assistant" && messages[1].finish).toBe("stop")
      expect(SessionTitle.isDefault((yield* session.get(sessionID)).title)).toBe(true)
    }),
  )

  it.live("does not block the prompt turn on a slow title generation", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      const gate = yield* Deferred.make<void>()
      titleReply = Stream.unwrap(
        Deferred.await(gate).pipe(Effect.as(Stream.fromIterable(reply("title", "Slow title")))),
      )
      const events = yield* EventV2.Service
      const changed = yield* events
        .subscribe(SessionEvent.TitleChanged)
        .pipe(Stream.runHead, Effect.forkScoped)

      yield* promptAndWait(session, "Hello")

      expect((yield* session.messages({ sessionID, order: "asc" })).map((message) => message.type)).toEqual([
        "user",
        "assistant",
      ])
      expect(SessionTitle.isDefault((yield* session.get(sessionID)).title)).toBe(true)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(changed)
      expect((yield* session.get(sessionID)).title).toBe("Slow title")
    }),
  )

  it.live("does not overwrite a title customized while generation was in flight", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      const gate = yield* Deferred.make<void>()
      titleReply = Stream.unwrap(
        Deferred.await(gate).pipe(Effect.as(Stream.fromIterable(reply("title", "Generated title")))),
      )
      const events = yield* EventV2.Service

      yield* promptAndWait(session, "Hello")
      yield* events.publish(SessionEvent.TitleChanged, {
        sessionID,
        timestamp: yield* DateTime.now,
        title: "Renamed by user",
      })
      yield* Deferred.succeed(gate, undefined)
      yield* settle

      expect((yield* session.get(sessionID)).title).toBe("Renamed by user")
    }),
  )
})

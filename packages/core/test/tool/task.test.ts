import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Auth, LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionDispatchPort } from "@opencode-ai/core/session/dispatch-port"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Location } from "@opencode-ai/core/location"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"

// Same fake-HTTP-per-model harness as session-runner-fallback.test.ts, plus a tool-call reply
// shape. Replies queue per model (FIFO) since a tool-calling turn needs a second, follow-up
// completion after the tool result is fed back -- one scripted reply per model is not enough.
type Reply = { readonly status: number; readonly body?: string }
const replies = new Map<string, Reply[]>()
function script(model: string, reply: Reply) {
  const queue = replies.get(model) ?? []
  queue.push(reply)
  replies.set(model, queue)
}
const calls: string[] = []
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ model: Schema.String })))
const sse = (chunks: unknown[]) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
const text = (value: string): Reply => ({
  status: 200,
  body: sse([{ choices: [{ delta: { content: value } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]),
})
const toolCall = (name: string, args: Record<string, unknown>): Reply => ({
  status: 200,
  body: sse([
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]),
})
// `retry-after-ms: 0` on the unscripted-default failure too, so a forgotten script entry fails
// fast (and loudly, via the resulting terminal LLMError) instead of hanging on real backoff.
const failure = (status: number, body = `HTTP ${status}`): Reply => ({ status, body })

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      const model = decodeBody(yield* Effect.promise(() => web.text())).model
      calls.push(model)
      const queue = replies.get(model) ?? []
      const reply = queue.shift() ?? failure(500, `No scripted reply for ${model}`)
      return HttpClientResponse.fromWeb(request, new Response(reply.body, { status: reply.status, headers: { "retry-after-ms": "0" } }))
    }),
  ),
)
const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))

const ref = (id: string) => ({ id: ModelV2.ID.make(id), providerID: ProviderV2.ID.make("fake") })
const primary = ref("primary")
const explorerModel = ref("explorer-model")
const missing = ref("missing")
const models = SessionRunnerModel.layerWith((session) => {
  const id = session.model?.id ?? primary.id
  if (id === missing.id)
    return Effect.fail(new SessionRunnerModel.ModelUnavailableError({ providerID: missing.providerID, modelID: missing.id }))
  return Effect.succeed({
    model: OpenAIChat.route
      .with({ provider: "fake", endpoint: { baseURL: "https://fake.test/v1" }, auth: Auth.bearer("fixture") })
      .model({ id }),
    info: ModelV2.Info.empty(ProviderV2.ID.make("fake"), ModelV2.ID.make(id)),
  })
})

// Real, functional permission service (unlike fallback test's decorative mock): `task` and
// `model_override` calls actually need to be evaluated since the tool under test asserts them.
const allowingPermission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const denyingPermission = (denyAction: string) =>
  Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      assert: (input) => {
        if (input.action !== denyAction) return Effect.void
        return Effect.fail(new Error(`Permission denied: ${input.action}`)) as unknown as ReturnType<
          PermissionV2.Interface["assert"]
        >
      },
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

const buildLayers = (permission: Layer.Layer<PermissionV2.Service>) => {
  const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
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
  // Proves the real composition-root wiring `server.ts` needs (see dispatch-port.ts's own doc
  // comment). A *raw* Layer (not a Node) as a replacement value: `LayerNode`'s own
  // `replacementNode()` auto-wraps a raw Layer with `deps: []`, exactly like `LocationServiceMap`
  // itself is supplied (`locationServiceMapV2` is a raw Layer too, never a Node). This matters
  // because `location-services.ts`'s own per-location `hoist()` recursively pulls in any *declared
  // node dependency* of a global-tagged replacement -- a `[SessionDispatchPort.node, nodeWithDeps]`
  // replacement whose own deps include `SessionV2.node` would drag `SessionV2.node`'s *entire*
  // graph (including its own unresolved `LocationServiceMap.node` dependency) into that same
  // per-location compile pass, which has no replacement for it there and would throw at runtime.
  // A raw Layer's requirement isn't a *declared graph edge* the hoist walk can see or follow at
  // all -- it leaks upward as an ordinary Effect requirement instead, satisfied later by whatever
  // composition provides `SessionV2.Service` as an ordinary peer (in the real server, the same
  // `AppNodeBuilderV1.build(SessionV2.node, [...])` peer that's already provided alongside
  // `locationServiceMapV2` today).
  const dispatchPortLayer = Layer.effect(
    SessionDispatchPort.Service,
    Effect.map(SessionV2.Service, (real) => real as unknown as SessionDispatchPort.Interface),
  )
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionExecution.node,
      SessionV2.node,
      AgentV2.node,
      ToolRegistry.node,
      TaskTool.node,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
    ]),
    [
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
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [SessionDispatchPort.node, dispatchPortLayer],
    ],
  )
}

const itWith = (permission: Layer.Layer<PermissionV2.Service>) => testEffect(buildLayers(permission))

const sessionID = SessionV2.ID.make("ses_task_tool")

const setup = (options?: { readonly explorerFallback?: string }) =>
  Effect.gen(function* () {
    replies.clear()
    calls.length = 0
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("build"), (agent) => {
        agent.mode = "primary"
      }),
    )
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("explorer"), (agent) => {
        agent.mode = "subagent"
        agent.system = "You are a focused explorer subagent."
        agent.model = options?.explorerFallback ? undefined : explorerModel
      }),
    )
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: "task tool",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }), resume: false })
    return session
  })

const sessionModel = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
    return row?.model
  })

describe("V2 task tool", () => {
  const it = itWith(allowingPermission)

  it.live("dispatches an isolated subagent session and returns its final answer", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      script(primary.id, toolCall("task", { description: "explore", prompt: "look around", subagent_type: "explorer" }))
      script(explorerModel.id, text("Explorer subagent result."))
      script(primary.id, text("Got the explorer's result."))

      yield* session.resume(sessionID)

      const context = yield* session.context(sessionID)
      const toolMessage = context.find(
        (message) => message.type === "assistant" && message.content.some((part) => part.type === "tool"),
      )
      expect(toolMessage).toBeDefined()
      const toolPart =
        toolMessage?.type === "assistant" ? toolMessage.content.find((part) => part.type === "tool") : undefined
      expect(toolPart?.type === "tool" && toolPart.state.status).toBe("completed")

      // A real, separate child session was created (not the parent re-answering itself), and it
      // really made its own LLM call against the configured explorer model.
      expect(calls).toContain(explorerModel.id)
      const { db } = yield* Database.Service
      const children = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(children).toHaveLength(1)
      expect(yield* sessionModel(children[0].id as SessionV2.ID)).toMatchObject({ id: "explorer-model" })
    }),
  )

  it.live("fails the tool call when the subagent type is unknown", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      script(primary.id, toolCall("task", { description: "explore", prompt: "look around", subagent_type: "does-not-exist" }))
      script(primary.id, text("Sorry, that agent type does not exist."))

      yield* session.resume(sessionID)

      const context = yield* session.context(sessionID)
      const toolMessage = context.find(
        (message) => message.type === "assistant" && message.content.some((part) => part.type === "tool"),
      )
      const toolPart =
        toolMessage?.type === "assistant" ? toolMessage.content.find((part) => part.type === "tool") : undefined
      expect(toolPart?.type === "tool" && toolPart.state.status).toBe("error")
    }),
  )

  it.live("overrides the subagent's model for this call only, with a control run confirming the default", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      const override = ref("override-model")
      script(
        primary.id,
        toolCall("task", {
          description: "explore",
          prompt: "look around",
          subagent_type: "explorer",
          model: "fake/override-model",
        }),
      )
      script(override.id, text("Explorer used the override model."))
      script(primary.id, text("Got the explorer's result via the override model."))

      yield* session.resume(sessionID)

      const { db } = yield* Database.Service
      const children = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(children).toHaveLength(1)
      expect(yield* sessionModel(children[0].id as SessionV2.ID)).toMatchObject({ id: "override-model" })
    }),
  )

  it.live("rejects the depth limit when a subagent tries to dispatch its own subagent", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      // Explorer is itself given task access and prompted to dispatch a second-level subagent.
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("explorer"), (agent) => {
          agent.permissions = [{ action: "task", resource: "*", effect: "allow" }]
        }),
      )
      script(primary.id, toolCall("task", { description: "explore", prompt: "go", subagent_type: "explorer" }))
      script(explorerModel.id, toolCall("task", { description: "nested", prompt: "go deeper", subagent_type: "explorer" }))
      // Explorer's own follow-up after its nested task call is rejected by the depth guard.
      script(explorerModel.id, text("Could not go deeper, depth limit reached."))
      script(primary.id, text("Got the explorer's (depth-limited) result."))

      yield* session.resume(sessionID)

      const { db } = yield* Database.Service
      const children = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(children).toHaveLength(1)
      const grandchildren = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, children[0].id))
        .all()
        .pipe(Effect.orDie)
      // The nested task call is rejected by the depth guard before a second child session exists.
      expect(grandchildren).toHaveLength(0)
    }),
  )
})

describe("V2 task tool permissions", () => {
  itWith(denyingPermission("task")).effect("respects a denied task permission", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      script(primary.id, toolCall("task", { description: "explore", prompt: "go", subagent_type: "explorer" }))
      script(primary.id, text("Sorry, task is not permitted right now."))

      yield* session.resume(sessionID)

      const context = yield* session.context(sessionID)
      const toolMessage = context.find(
        (message) => message.type === "assistant" && message.content.some((part) => part.type === "tool"),
      )
      const toolPart =
        toolMessage?.type === "assistant" ? toolMessage.content.find((part) => part.type === "tool") : undefined
      expect(toolPart?.type === "tool" && toolPart.state.status).toBe("error")
      expect(calls.includes(explorerModel.id)).toBe(false)
    }),
  )

  itWith(denyingPermission("model_override")).effect("respects a denied model_override permission", () =>
    Effect.gen(function* () {
      const session = yield* setup()
      script(
        primary.id,
        toolCall("task", {
          description: "explore",
          prompt: "go",
          subagent_type: "explorer",
          model: "fake/override-model",
        }),
      )
      script(primary.id, text("Sorry, model override is not permitted right now."))

      yield* session.resume(sessionID)

      const context = yield* session.context(sessionID)
      const toolMessage = context.find(
        (message) => message.type === "assistant" && message.content.some((part) => part.type === "tool"),
      )
      const toolPart =
        toolMessage?.type === "assistant" ? toolMessage.content.find((part) => part.type === "tool") : undefined
      expect(toolPart?.type === "tool" && toolPart.state.status).toBe("error")
    }),
  )
})

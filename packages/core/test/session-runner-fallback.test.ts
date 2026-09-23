import { describe, expect, test } from "bun:test"
import {
  LLMError,
  LLMEvent,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  AuthenticationReason,
  InvalidRequestReason,
  HttpContext,
  HttpRequestDetails,
  HttpResponseDetails,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
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
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerFallback } from "@opencode-ai/core/session/runner/fallback"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
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
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "./lib/effect"

type Reply = { readonly status: number; readonly body?: string; readonly headers?: Record<string, string> }

// Per-model scripted HTTP replies. The real RequestExecutor classifies statuses and spends its retry budget,
// so the runner only sees what survives transport retries — the exact boundary fallback is meant to cover.
// A function reply is resolved fresh on every call, so a test can flip a model's outcome mid-run — e.g. to
// prove a circular fallback chain genuinely walks back to a model that was failing and retries it for real.
const replies = new Map<string, Reply | (() => Reply)>()
const calls: string[] = []
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ model: Schema.String })))
const success = (text: string): Reply => ({
  status: 200,
  headers: { "content-type": "text/event-stream" },
  body: [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join(""),
})
// `retry-after-ms: 0` keeps RequestExecutor's real retries without real backoff sleeps.
const failure = (status: number, body = `HTTP ${status}`): Reply => ({
  status,
  body,
  headers: { "retry-after-ms": "0" },
})
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      const model = decodeBody(yield* Effect.promise(() => web.text())).model
      calls.push(model)
      const scripted = replies.get(model) ?? failure(500, `No scripted reply for ${model}`)
      const reply = typeof scripted === "function" ? scripted() : scripted
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.body, { status: reply.status, headers: reply.headers }),
      )
    }),
  ),
)
const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(http))))

const ref = (id: string) => ({ id: ModelV2.ID.make(id), providerID: ProviderV2.ID.make("fake") })
const primary = ref("primary")
const backup = ref("backup")
const spare = ref("spare")
const missing = ref("missing")
const models = SessionRunnerModel.layerWith((session) => {
  const id = session.model?.id ?? primary.id
  if (id === missing.id)
    return Effect.fail(
      new SessionRunnerModel.ModelUnavailableError({ providerID: missing.providerID, modelID: missing.id }),
    )
  return Effect.succeed({
    model: OpenAIChat.route
      .with({ provider: "fake", endpoint: { baseURL: "https://fake.test/v1" }, auth: Auth.bearer("fixture") })
      .model({ id }),
    info: ModelV2.Info.empty(ProviderV2.ID.make("fake"), ModelV2.ID.make(id)),
  })
})

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
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_runner_fallback")

const setup = (fallback: ReadonlyArray<ModelV2.Ref>, fallbackCircular = false) =>
  Effect.gen(function* () {
    replies.clear()
    calls.length = 0
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("build"), (agent) => {
        agent.mode = "primary"
        agent.fallback = fallback.map((item) => ({ ...item }))
        agent.fallbackCircular = fallbackCircular
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
        title: "fallback",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }), resume: false })
    return session
  })

const sessionModel = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
  return row?.model
})

describe("SessionRunner fallback", () => {
  it.live("fails over to the next model after the primary exhausts its transport retries", () =>
    Effect.gen(function* () {
      const session = yield* setup([backup])
      replies.set(primary.id, failure(429))
      replies.set(backup.id, success("Served by backup"))

      yield* session.resume(sessionID)

      // RequestExecutor: 1 attempt + 2 retries against the primary before the runner fails over.
      expect(calls).toEqual(["primary", "primary", "primary", "backup"])
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Hello" },
        { type: "model-switched", model: { id: "backup", providerID: "fake" } },
        {
          type: "assistant",
          model: { id: "backup", providerID: "fake" },
          content: [{ type: "text", text: "Served by backup" }],
        },
      ])
      // The failed primary attempt must not leave a durable failed assistant message behind.
      expect(context.filter((message) => message.type === "assistant")).toHaveLength(1)
      expect(yield* sessionModel).toMatchObject({ id: "backup", providerID: "fake" })
    }),
  )

  it.live("skips unresolvable fallbacks and walks the chain in order", () =>
    Effect.gen(function* () {
      const session = yield* setup([missing, backup, spare])
      replies.set(primary.id, failure(503))
      replies.set(backup.id, failure(529))
      replies.set(spare.id, success("Served by spare"))

      yield* session.resume(sessionID)

      expect(calls).toEqual(["primary", "primary", "primary", "backup", "backup", "backup", "spare"])
      const context = yield* session.context(sessionID)
      expect(context.filter((message) => message.type === "model-switched")).toMatchObject([
        { model: { id: "backup" } },
        { model: { id: "spare" } },
      ])
      expect(context.filter((message) => message.type === "assistant")).toMatchObject([
        { model: { id: "spare" }, content: [{ type: "text", text: "Served by spare" }] },
      ])
    }),
  )

  it.live("falls back on non-retried quota failures without spending transport retries", () =>
    Effect.gen(function* () {
      const session = yield* setup([backup])
      replies.set(primary.id, failure(429, '{"error":{"code":"insufficient_quota"}}'))
      replies.set(backup.id, success("Served by backup"))

      yield* session.resume(sessionID)

      expect(calls).toEqual(["primary", "backup"])
      expect(yield* sessionModel).toMatchObject({ id: "backup" })
    }),
  )

  it.live("does not fall back on non-retryable authentication failures", () =>
    Effect.gen(function* () {
      const session = yield* setup([backup])
      replies.set(primary.id, failure(401))
      replies.set(backup.id, success("Served by backup"))

      const error = yield* session.resume(sessionID).pipe(Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(calls).toEqual(["primary"])
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "model-switched")).toBe(false)
      expect(context.filter((message) => message.type === "assistant")).toMatchObject([
        { model: { id: "primary" }, finish: "error" },
      ])
      expect(yield* sessionModel).toBeNull()
    }),
  )

  it.live("surfaces the terminal failure once the fallback chain is exhausted", () =>
    Effect.gen(function* () {
      const session = yield* setup([backup])
      replies.set(primary.id, failure(503))
      replies.set(backup.id, failure(503, "backup down"))

      const error = yield* session.resume(sessionID).pipe(Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(error instanceof LLMError && error.reason._tag).toBe("ProviderInternal")
      expect(calls).toEqual(["primary", "primary", "primary", "backup", "backup", "backup"])
      const context = yield* session.context(sessionID)
      expect(context.filter((message) => message.type === "assistant")).toMatchObject([
        { model: { id: "backup" }, finish: "error" },
      ])
    }),
  )

  it.live("keeps the terminal failure when no fallback is configured", () =>
    Effect.gen(function* () {
      const session = yield* setup([])
      replies.set(primary.id, failure(503))

      const error = yield* session.resume(sessionID).pipe(Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(calls).toEqual(["primary", "primary", "primary"])
      expect(yield* sessionModel).toBeNull()
    }),
  )

  it.live("circular: retries the original model once the whole fallback chain fails, and succeeds there", () =>
    Effect.gen(function* () {
      const session = yield* setup([backup], true)
      // Fails for its first attempt-set (the initial 1 + 2 retries), then succeeds — proving the
      // circular retry is a real second attempt against `primary`, not a no-op or a stale success.
      let primaryCalls = 0
      replies.set(primary.id, () => {
        primaryCalls++
        return primaryCalls <= 3 ? failure(503) : success("Served by primary the second time around")
      })
      replies.set(backup.id, failure(503, "backup down"))

      yield* session.resume(sessionID)

      expect(calls).toEqual(["primary", "primary", "primary", "backup", "backup", "backup", "primary"])
      const context = yield* session.context(sessionID)
      expect(context.filter((message) => message.type === "model-switched")).toMatchObject([
        { model: { id: "backup" } },
        { model: { id: "primary" } },
      ])
      expect(context.filter((message) => message.type === "assistant")).toMatchObject([
        { model: { id: "primary" }, content: [{ type: "text", text: "Served by primary the second time around" }] },
      ])
      expect(yield* sessionModel).toMatchObject({ id: "primary" })
    }),
  )

  it.live("circular: still surfaces the terminal failure after one full circuit back to the original model", () =>
    Effect.gen(function* () {
      const session = yield* setup([backup], true)
      replies.set(primary.id, failure(503))
      replies.set(backup.id, failure(503, "backup down"))

      const error = yield* session.resume(sessionID).pipe(Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      // primary x3, backup x3, then the circular retry of primary x3 — then truly exhausted.
      expect(calls).toEqual([
        "primary",
        "primary",
        "primary",
        "backup",
        "backup",
        "backup",
        "primary",
        "primary",
        "primary",
      ])
      const context = yield* session.context(sessionID)
      expect(context.filter((message) => message.type === "assistant")).toMatchObject([
        { model: { id: "primary" }, finish: "error" },
      ])
    }),
  )

  it.live("does not circle back when fallbackCircular is not set", () =>
    Effect.gen(function* () {
      const session = yield* setup([backup], false)
      replies.set(primary.id, failure(503))
      replies.set(backup.id, failure(503, "backup down"))

      const error = yield* session.resume(sessionID).pipe(Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(calls).toEqual(["primary", "primary", "primary", "backup", "backup", "backup"])
    }),
  )
})

const http404 = new HttpContext({
  request: new HttpRequestDetails({ method: "POST", url: "https://fake.test", headers: {} }),
  response: new HttpResponseDetails({ status: 404, headers: {} }),
})
const llmError = (reason: LLMError["reason"]) => new LLMError({ module: "test", method: "stream", reason })

describe("SessionRunnerFallback", () => {
  test("classifies failures that a different model can recover", () => {
    expect(SessionRunnerFallback.shouldFallback(llmError(new RateLimitReason({ message: "429" })))).toBe(true)
    expect(SessionRunnerFallback.shouldFallback(llmError(new QuotaExceededReason({ message: "quota" })))).toBe(true)
    expect(SessionRunnerFallback.shouldFallback(llmError(new TransportReason({ message: "reset" })))).toBe(true)
    expect(
      SessionRunnerFallback.shouldFallback(llmError(new InvalidRequestReason({ message: "no model", http: http404 }))),
    ).toBe(true)
    expect(
      SessionRunnerFallback.shouldFallback(LLMEvent.providerError({ message: "throttled", retryable: true })),
    ).toBe(true)
  })

  test("rejects failures that would repeat on any model", () => {
    expect(
      SessionRunnerFallback.shouldFallback(llmError(new AuthenticationReason({ message: "401", kind: "invalid" }))),
    ).toBe(false)
    expect(SessionRunnerFallback.shouldFallback(llmError(new InvalidRequestReason({ message: "bad request" })))).toBe(
      false,
    )
    expect(
      SessionRunnerFallback.shouldFallback(
        llmError(new InvalidRequestReason({ message: "too long", classification: "context-overflow", http: http404 })),
      ),
    ).toBe(false)
    expect(SessionRunnerFallback.shouldFallback(LLMEvent.providerError({ message: "stream error" }))).toBe(false)
    expect(SessionRunnerFallback.shouldFallback(new Error("defect"))).toBe(false)
    expect(SessionRunnerFallback.shouldFallback(undefined)).toBe(false)
  })

  test("orders untried candidates and skips the current model", () => {
    expect(SessionRunnerFallback.candidates(primary, [backup, primary, spare], [])).toEqual([backup, spare])
    expect(SessionRunnerFallback.candidates(backup, [backup, spare], [primary])).toEqual([spare])
    expect(SessionRunnerFallback.candidates(spare, [backup, spare], [primary, backup])).toEqual([])
  })

  test("circular: offers the original model once every fallback is exhausted", () => {
    // Same exhausted state as the non-circular case above, but with circular=true.
    expect(SessionRunnerFallback.candidates(spare, [backup, spare], [primary, backup], true)).toEqual([primary])
  })

  test("circular: stops after the original model's own circular retry fails, rather than looping forever", () => {
    // `current === tried[0]` marks that the circular retry of `primary` itself just failed.
    expect(SessionRunnerFallback.candidates(primary, [backup, spare], [primary, backup, spare], true)).toEqual([])
  })

  test("circular has no effect while untried fallbacks remain", () => {
    expect(SessionRunnerFallback.candidates(primary, [backup, spare], [], true)).toEqual([backup, spare])
  })

  test("circular is a no-op with no fallback history to circle back to", () => {
    expect(SessionRunnerFallback.candidates(primary, [], [], true)).toEqual([])
  })
})

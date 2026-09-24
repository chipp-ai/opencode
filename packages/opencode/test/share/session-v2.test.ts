import { beforeEach, describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSharePort } from "@opencode-ai/core/session/share-port"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { AccountRepo } from "../../src/account/repo"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { ShareNext } from "@/share/share-next"
import { SessionShareV2 } from "@/share/session-v2"
import { tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(CrossSpawnSpawner.node))

const backendURL = "https://share-backend.example.com"

type Seen = { method: string; url: string; body: unknown }
type SyncItem = { type: string; data: Record<string, unknown> }

// Fakes the hosted share backend the same way share-next.test.ts does: an HttpClient replacement.
function backend() {
  const seen: Seen[] = []
  const client = HttpClient.make((req: HttpClientRequest.HttpClientRequest) => {
    seen.push({
      method: req.method,
      url: req.url,
      body: req.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(req.body.body)) : undefined,
    })
    const body =
      req.method === "POST" && req.url.endsWith("/api/share")
        ? { id: "shr_v2", url: `${backendURL}/share/v2`, secret: "sec_v2" }
        : {}
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        req,
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
      ),
    )
  })
  return { seen, client }
}

// Real SessionV2 with the real V2 share orchestrator bound to its port, over the real app-layer services it uses.
function layer(client: HttpClient.HttpClient) {
  const app = AppNodeBuilder.build(
    LayerNode.group([
      ShareNext.node,
      Session.node,
      Provider.node,
      Config.node,
      InstanceStore.node,
      AccountRepo.node,
      Database.node,
      EventV2.node,
    ]),
    [
      [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  )
  const sessions = AppNodeBuilder.build(LayerNode.group([SessionV2.node, SessionProjector.node]), [
    [SessionExecution.node, SessionExecution.noopLayer],
    [SessionSharePort.node, SessionShareV2.layer],
  ])
  return sessions.pipe(Layer.provideMerge(app))
}

const project = <A>(
  fn: (
    directory: string,
    seen: Seen[],
  ) => Effect.Effect<A, unknown, SessionV2.Service | Database.Service | EventV2.Service>,
) =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true, config: { enterprise: { url: backendURL } } })
    const fake = backend()
    const result = yield* fn(directory, fake.seen).pipe(Effect.provide(layer(fake.client)))
    return { seen: fake.seen, result }
  })

const locationOf = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })

const shareRow = (sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* database.db
      .select()
      .from(SessionShareTable)
      .where(eq(SessionShareTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const prompt = (sessionID: SessionV2.ID, text: string) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.Prompted, {
      sessionID,
      timestamp: yield* DateTime.now,
      messageID: SessionMessage.ID.create(),
      prompt: Prompt.make({ text }),
      delivery: "steer",
    })
  })

const syncs = (seen: Seen[]) =>
  seen.filter((item) => item.method === "POST" && item.url === `${backendURL}/api/share/shr_v2/sync`)
const items = (item: Seen) => (item.body as { data: SyncItem[] }).data
const syncWithText = (seen: Seen[], text: string) =>
  syncs(seen).find((sync) => items(sync).some((item) => item.type === "part" && item.data.text === text))

// Keeps the layer (and its sync fibers) alive until a sync carrying `text` reaches the fake backend.
const awaitSync = (seen: Seen[], text: string) =>
  pollWithTimeout(
    Effect.sync(() => syncWithText(seen, text)),
    `timed out waiting for a share sync containing "${text}"`,
    "8 seconds",
  )

beforeEach(async () => {
  await resetDatabase()
})

describe("SessionShareV2", () => {
  it.live("share creates the hosted share, persists the row, and syncs the V2 transcript", () =>
    Effect.gen(function* () {
      const run = yield* project((directory, seen) =>
        Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const created = yield* sessions.create({ location: locationOf(directory) })
          yield* prompt(created.id, "hello shared world")

          const result = yield* sessions.share(created.id)

          expect(result.url).toBe(`${backendURL}/share/v2`)
          expect(yield* shareRow(created.id)).toMatchObject({ id: "shr_v2", secret: "sec_v2", url: result.url })
          expect((yield* sessions.get(created.id)).share).toEqual({ url: result.url })
          return { sessionID: created.id, sync: yield* awaitSync(seen, "hello shared world") }
        }),
      )

      expect(run.seen[0]).toMatchObject({
        method: "POST",
        url: `${backendURL}/api/share`,
        body: { sessionID: run.result.sessionID },
      })
      expect((run.result.sync.body as { secret: string }).secret).toBe("sec_v2")
      const data = items(run.result.sync)
      expect(data.find((item) => item.type === "session")?.data).toMatchObject({
        id: run.result.sessionID,
        share: { url: `${backendURL}/share/v2` },
      })
      expect(data.find((item) => item.type === "message")?.data).toMatchObject({
        sessionID: run.result.sessionID,
        role: "user",
      })
      expect(data.find((item) => item.type === "part")?.data).toMatchObject({
        type: "text",
        text: "hello shared world",
      })
    }),
  )

  it.live("a durable session event after sharing resyncs the session's current data", () =>
    Effect.gen(function* () {
      const run = yield* project((directory, seen) =>
        Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const events = yield* EventV2.Service
          const created = yield* sessions.create({ location: locationOf(directory) })
          yield* sessions.share(created.id)

          yield* events.publish(SessionEvent.TitleChanged, {
            sessionID: created.id,
            timestamp: yield* DateTime.now,
            title: "renamed after sharing",
          })
          yield* prompt(created.id, "a later prompt")

          return yield* awaitSync(seen, "a later prompt")
        }),
      )

      expect(items(run.result).find((item) => item.type === "session")?.data).toMatchObject({
        title: "renamed after sharing",
      })
    }),
  )

  it.live("unshare calls the remove endpoint and deletes the share row", () =>
    Effect.gen(function* () {
      const run = yield* project((directory) =>
        Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const created = yield* sessions.create({ location: locationOf(directory) })
          yield* sessions.share(created.id)

          yield* sessions.unshare(created.id)

          expect(yield* shareRow(created.id)).toBeUndefined()
          expect((yield* sessions.get(created.id)).share).toBeUndefined()
        }),
      )

      expect(run.seen.filter((item) => item.method === "DELETE")).toEqual([
        { method: "DELETE", url: `${backendURL}/api/share/shr_v2`, body: { secret: "sec_v2" } },
      ])
    }),
  )

  it.live("events on an unshared session never reach the share backend", () =>
    Effect.gen(function* () {
      const run = yield* project((directory) =>
        Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const created = yield* sessions.create({ location: locationOf(directory) })
          yield* prompt(created.id, "private")
          // Outlasts the orchestrator's debounce window, so the absence of a request is meaningful.
          yield* Effect.sleep("1500 millis")
        }),
      )

      expect(run.seen).toEqual([])
    }),
  )
})

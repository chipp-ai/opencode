import { Duration, Effect, Layer, Schema, Scope, Stream } from "effect"
import { asc, desc, eq } from "drizzle-orm"
import type * as SDK from "@opencode-ai/sdk/v2"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionSharePort } from "@opencode-ai/core/session/share-port"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { toV1Transcript } from "@opencode-ai/tui/util/v2-session"
import { Config } from "@/config/config"
import { InstanceStore } from "@/project/instance-store"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ShareNext } from "./share-next"

// Durable V2 events arrive in bursts (one per text/tool/step boundary); snapshots are rebuilt at most once per window.
const DEBOUNCE = Duration.seconds(1)
// Round-trips stored rows into the encoded wire form, which is the SDK shape the transcript converter takes.
const toWire = Schema.decodeUnknownEffect(Schema.toEncoded(SessionMessage.Message))

/**
 * The real `SessionSharePort` for V2 sessions, supplied at the composition root. It reuses `ShareNext` for the hosted
 * share wire protocol and the `session_share` row, but syncs V2's projected transcript: after any durable
 * `session.next.*` event on a shared Session, it resends the Session info and every message converted to the V1
 * message/part shapes the share viewer renders. The backend merges items by key, so a full resend is idempotent.
 *
 * A raw Layer rather than a node, like the dispatch port: its app-layer requirements (`ShareNext`, `Session`,
 * `InstanceStore`, ...) are satisfied by the application graph provided beneath `SessionV2` in `server.ts`.
 */
export const layer = Layer.effect(
  SessionSharePort.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const shareNext = yield* ShareNext.Service
    const session = yield* Session.Service
    const provider = yield* Provider.Service
    const cfg = yield* Config.Service
    const instances = yield* InstanceStore.Service
    const scope = yield* Scope.Scope
    const pending = new Set<SessionID>()

    // ShareNext keeps its cache and auth per instance, so every call runs inside the Session's own directory.
    const inSession = <A, E, R>(sessionID: SessionID, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const info = yield* session.get(sessionID)
        return yield* instances.provide({ directory: info.directory }, effect)
      })

    const shareURL = (sessionID: SessionID) =>
      database.db
        .select({ url: SessionShareTable.url })
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.url),
        )

    const push = Effect.fn("SessionShareV2.push")(function* (sessionID: SessionID, url: string) {
      const info = yield* session.get(sessionID)
      const rows = yield* database.db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(desc(SessionMessageTable.seq), asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = yield* Effect.forEach(rows, (row) =>
        toWire({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
      )
      const transcript = toV1Transcript({
        sessionID,
        directory: info.directory,
        messages: messages.map((message) => structuredClone(message) as SDK.SessionMessage),
        agent: info.agent,
        model: info.model,
      })
      const refs = new Map(
        transcript.messages.flatMap((message) =>
          message.role === "user" && message.model.providerID && message.model.modelID
            ? [[`${message.model.providerID}/${message.model.modelID}`, message.model] as const]
            : [],
        ),
      )
      // A model the provider catalog no longer knows only loses its display metadata in the shared view.
      const models = yield* Effect.forEach(
        Array.from(refs.values()),
        (ref) =>
          provider.getModel(ProviderV2.ID.make(ref.providerID), ModelV2.ID.make(ref.modelID)).pipe(Effect.option),
        { concurrency: 8 },
      )
      yield* shareNext.sync(sessionID, [
        { type: "session", data: { ...info, share: { url } } },
        ...transcript.messages.map((message) => ({ type: "message" as const, data: message })),
        ...transcript.messages.flatMap((message) =>
          (transcript.parts[message.id] ?? []).map((part) => ({ type: "part" as const, data: part })),
        ),
        { type: "model", data: models.flatMap((model) => (model._tag === "Some" ? [model.value] : [])) },
      ])
    })

    const schedule = (sessionID: SessionID) => {
      if (pending.has(sessionID)) return Effect.void
      pending.add(sessionID)
      return Effect.gen(function* () {
        yield* Effect.sleep(DEBOUNCE)
        pending.delete(sessionID)
        const url = yield* shareURL(sessionID)
        if (!url) return
        yield* inSession(sessionID, push(sessionID, url))
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("V2 share sync failed", { sessionID, cause })),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    }

    yield* events.all().pipe(
      Stream.filter((event) => event.durable !== undefined && event.type.startsWith("session.next.")),
      Stream.runForEach((event) => schedule(SessionID.make(event.durable!.aggregateID))),
      Effect.forkScoped,
    )

    return SessionSharePort.Service.of({
      share: (sessionID) =>
        inSession(
          sessionID,
          Effect.gen(function* () {
            const conf = yield* cfg.get()
            if (conf.share === "disabled") return yield* Effect.fail(new Error("Sharing is disabled in configuration"))
            const result = yield* shareNext.create(sessionID, { full: false })
            yield* push(sessionID, result.url)
            return { url: result.url }
          }),
        ),
      unshare: (sessionID) => inSession(sessionID, shareNext.remove(sessionID)),
    })
  }),
)

export * as SessionShareV2 from "./session-v2"

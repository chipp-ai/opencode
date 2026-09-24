import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSharePort } from "@opencode-ai/core/session/share-port"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

// Stands in for the app-layer implementation: records the hosted share row the way ShareNext does.
const calls: string[] = []
const port = Layer.effect(
  SessionSharePort.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return SessionSharePort.Service.of({
      share: (sessionID) =>
        Effect.gen(function* () {
          calls.push(`share:${sessionID}`)
          if (sessionID === failing) return yield* Effect.fail(new Error("share backend unavailable"))
          const url = `https://share.example.com/${sessionID}`
          yield* db
            .insert(SessionShareTable)
            .values({ session_id: sessionID, id: `shr_${sessionID}`, secret: "secret", url })
            .run()
            .pipe(Effect.orDie)
          return { url }
        }),
      unshare: (sessionID) =>
        Effect.gen(function* () {
          calls.push(`unshare:${sessionID}`)
          yield* db
            .delete(SessionShareTable)
            .where(eq(SessionShareTable.session_id, sessionID))
            .run()
            .pipe(Effect.orDie)
        }),
    })
  }),
)

const graph = LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node])
const it = testEffect(
  AppNodeBuilder.build(graph, [
    [ProjectV2.node, projects],
    [SessionExecution.node, SessionExecution.noopLayer],
    [SessionSharePort.node, port],
  ]),
)
const unavailable = testEffect(
  AppNodeBuilder.build(graph, [
    [ProjectV2.node, projects],
    [SessionExecution.node, SessionExecution.noopLayer],
  ]),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const failing = SessionV2.ID.make("ses_share_failing")

describe("SessionV2.share", () => {
  it.effect("shares through the port and projects the share URL onto the Session info", () =>
    Effect.gen(function* () {
      calls.length = 0
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      expect(created.share).toBeUndefined()

      const result = yield* session.share(created.id)

      expect(result.url).toBe(`https://share.example.com/${created.id}`)
      expect(calls).toEqual([`share:${created.id}`])
      expect((yield* session.get(created.id)).share).toEqual({ url: result.url })
      expect((yield* session.list()).find((item) => item.id === created.id)?.share).toEqual({ url: result.url })
    }),
  )

  it.effect("unshares through the port and drops the projected share URL", () =>
    Effect.gen(function* () {
      calls.length = 0
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      yield* session.share(created.id)

      yield* session.unshare(created.id)

      expect(calls).toEqual([`share:${created.id}`, `unshare:${created.id}`])
      expect((yield* session.get(created.id)).share).toBeUndefined()
    }),
  )

  it.effect("fails with NotFoundError for an unknown Session without calling the port", () =>
    Effect.gen(function* () {
      calls.length = 0
      const session = yield* SessionV2.Service
      const exit = yield* session.share(SessionV2.ID.make("ses_share_missing")).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("Session.NotFoundError")
      expect(calls).toEqual([])
    }),
  )

  it.effect("maps port failures to ShareError with the underlying message", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      yield* session.create({ id: failing, location })

      const error = yield* session.share(failing).pipe(Effect.flip)

      expect(error).toBeInstanceOf(SessionV2.ShareError)
      expect(error.message).toBe("share backend unavailable")
      expect((yield* session.get(failing)).share).toBeUndefined()
    }),
  )

  unavailable.effect("reports sharing as unavailable when no implementation is composed", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      const error = yield* session.share(created.id).pipe(Effect.flip)

      expect(error).toBeInstanceOf(SessionV2.ShareError)
      expect(error.message).toBe("Session sharing is not available in this server")
    }),
  )
})

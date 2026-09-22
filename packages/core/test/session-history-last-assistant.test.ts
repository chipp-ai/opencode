import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const sessionID = SessionV2.ID.make("ses_last_assistant_test")
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const seedSession = Effect.fn(function* (id: SessionV2.ID) {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id,
      project_id: ProjectV2.ID.global,
      slug: id,
      directory: "/project",
      title: id,
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const assistantRow = (id: SessionMessage.ID, seq: number, cost: number) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({
      id,
      type: "assistant",
      agent: "build",
      model,
      content: [{ type: "text", id: `part_${seq}`, text: `reply ${seq}` }],
      cost,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      time: { created: DateTime.makeUnsafe(0) },
    }),
  )
  return { id, session_id: sessionID, type, seq, time_created: 0, data }
}

describe("SessionHistory.lastAssistant", () => {
  it.effect("returns undefined when the session has no assistant message yet", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      expect(yield* SessionHistory.lastAssistant(db, sessionID)).toBeUndefined()
    }),
  )

  it.effect("returns the most recent assistant message, fully decoded", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedSession(sessionID)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_a1"), 0, 0.01),
          assistantRow(SessionMessage.ID.make("msg_a2"), 1, 0.02),
        ])
        .run()
        .pipe(Effect.orDie)

      const last = yield* SessionHistory.lastAssistant(db, sessionID)

      expect(last?.type).toBe("assistant")
      expect(last?.cost).toBe(0.02)
      expect(last?.finish).toBe("stop")
      expect(last?.tokens?.input).toBe(10)
    }),
  )

  it.effect("skips non-assistant rows", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const otherSessionID = SessionV2.ID.make("ses_last_assistant_other")
      yield* seedSession(otherSessionID)
      const {
        id: _,
        type,
        ...data
      } = encodeMessage(
        SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_user"),
          type: "user",
          text: "hi",
          time: { created: DateTime.makeUnsafe(0) },
        }),
      )
      yield* db
        .insert(SessionMessageTable)
        .values({ id: SessionMessage.ID.make("msg_user"), session_id: otherSessionID, type, seq: 0, time_created: 0, data })
        .run()
        .pipe(Effect.orDie)

      expect(yield* SessionHistory.lastAssistant(db, otherSessionID)).toBeUndefined()
    }),
  )
})
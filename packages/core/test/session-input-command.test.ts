import { describe, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionInputTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionV2.ID.make("ses_command")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return { db, events: yield* EventV2.Service }
})

const admit = (id: string, commandId: string, inputFingerprint: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    return yield* SessionInput.admit(db, events, {
      id: SessionMessage.ID.make(id),
      sessionID,
      prompt: Prompt.make({ text: "do the thing" }),
      delivery: "queue",
      commandId,
      inputFingerprint,
    })
  })

describe("SessionInput command idempotency", () => {
  it.effect("a retried command resolves to the first admission even with a new message id", () =>
    Effect.gen(function* () {
      const { db } = yield* setup
      const first = yield* admit("msg_first", "cmd_1", "fp_a")
      const retry = yield* admit("msg_retry", "cmd_1", "fp_a")
      expect(retry.id).toBe(first.id)
      expect(retry.admittedSeq).toBe(first.admittedSeq)
      expect(first).toMatchObject({ commandId: "cmd_1", inputFingerprint: "fp_a" })
      const rows = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => String(row.id))).toEqual(["msg_first"])
      expect(yield* SessionInput.findByCommand(db, sessionID, "cmd_1")).toMatchObject({
        id: SessionMessage.ID.make("msg_first"),
      })
    }),
  )

  it.effect("the same command with a different fingerprint is a conflict", () =>
    Effect.gen(function* () {
      yield* setup
      yield* admit("msg_first", "cmd_1", "fp_a")
      const exit = yield* admit("msg_other", "cmd_1", "fp_b").pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SessionInput.CommandConflict)
    }),
  )

  it.effect("prompts without a command id never collide", () =>
    Effect.gen(function* () {
      const { db, events } = yield* setup
      const plain = (id: string) =>
        SessionInput.admit(db, events, {
          id: SessionMessage.ID.make(id),
          sessionID,
          prompt: Prompt.make({ text: "hi" }),
          delivery: "queue",
        })
      const one = yield* plain("msg_a")
      const two = yield* plain("msg_b")
      expect(one.commandId).toBeUndefined()
      expect(two.admittedSeq).toBe(one.admittedSeq + 1)
    }),
  )
})

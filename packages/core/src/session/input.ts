export * as SessionInput from "./input"

import { and, asc, eq, isNull, lte } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Admitted, Delivery } from "@opencode-ai/schema/session-input"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export { Admitted, Delivery }

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)

const fromRow = (row: typeof SessionInputTable.$inferSelect): Admitted =>
  Admitted.make({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    prompt: decodePrompt(row.prompt),
    delivery: row.delivery,
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
    ...(row.withdrawn_seq === null ? {} : { withdrawnSeq: row.withdrawn_seq }),
  })

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
  },
) {
  const existing = yield* find(db, input.id)
  if (existing !== undefined) return existing
  const timestamp = yield* DateTime.now
  return yield* events
    .publish(SessionEvent.PromptAdmitted, {
      messageID: input.id,
      sessionID: input.sessionID,
      timestamp,
      prompt: input.prompt,
      delivery: input.delivery,
    })
    .pipe(
      Effect.flatMap((event) =>
        event.durable === undefined
          ? Effect.die("Prompt admission event is missing aggregate sequence")
          : Effect.succeed(
              Admitted.make({
                admittedSeq: event.durable.seq,
                id: input.id,
                sessionID: input.sessionID,
                prompt: input.prompt,
                delivery: input.delivery,
                timeCreated: timestamp,
              }),
            ),
      ),
      Effect.catchDefect((defect) =>
        find(db, input.id).pipe(Effect.flatMap((stored) => (stored ? Effect.succeed(stored) : Effect.die(defect)))),
      ),
    )
})

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
  },
) {
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.admittedSeq,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectPrompted = Effect.fn("SessionInput.projectPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.withdrawn_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated) {
    const stored = fromRow(updated)
    if (!matchesProjection(stored, input)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  const stored = yield* find(db, input.id)
  if (stored) {
    if (stored.withdrawnSeq !== undefined) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    if (!matchesProjection(stored, input) || stored.promotedSeq !== input.promotedSeq)
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      prompt: encodePrompt(input.prompt),
      delivery: input.delivery,
      admitted_seq: input.promotedSeq,
      promoted_seq: input.promotedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .run()
    .pipe(Effect.orDie)
})

export class NotPending extends Schema.TaggedErrorClass<NotPending>()("SessionInput.NotPending", {
  id: SessionMessage.ID,
}) {}

/** Lists admitted inputs that have been neither promoted nor withdrawn, in promotion order. */
export const listPending = Effect.fn("SessionInput.listPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.withdrawn_seq),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

/** Withdraws one pending input. Fails with NotPending once the input was promoted, withdrawn, or never admitted. */
export const withdraw = Effect.fn("SessionInput.withdraw")(function* (
  events: EventV2.Interface,
  input: { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID },
) {
  yield* events
    .publish(SessionEvent.PromptWithdrawn, {
      sessionID: input.sessionID,
      messageID: input.id,
      timestamp: yield* DateTime.now,
    })
    .pipe(Effect.catchDefect((defect) => (defect instanceof NotPending ? Effect.fail(defect) : Effect.die(defect))))
})

/** Replaces the prompt of one pending input, keeping its delivery and queue position. */
export const revise = Effect.fn("SessionInput.revise")(function* (
  events: EventV2.Interface,
  input: { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID; readonly prompt: Prompt },
) {
  yield* events
    .publish(SessionEvent.PromptRevised, {
      sessionID: input.sessionID,
      messageID: input.id,
      prompt: input.prompt,
      timestamp: yield* DateTime.now,
    })
    .pipe(Effect.catchDefect((defect) => (defect instanceof NotPending ? Effect.fail(defect) : Effect.die(defect))))
})

export const projectWithdrawn = Effect.fn("SessionInput.projectWithdrawn")(function* (
  db: DatabaseService,
  input: { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID; readonly withdrawnSeq: number },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ withdrawn_seq: input.withdrawnSeq })
    .where(pendingRow(input))
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new NotPending({ id: input.id }))
})

export const projectRevised = Effect.fn("SessionInput.projectRevised")(function* (
  db: DatabaseService,
  input: { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID; readonly prompt: Prompt },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ prompt: encodePrompt(input.prompt) })
    .where(pendingRow(input))
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new NotPending({ id: input.id }))
})

const pendingRow = (input: { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID }) =>
  and(
    eq(SessionInputTable.id, input.id),
    eq(SessionInputTable.session_id, input.sessionID),
    isNull(SessionInputTable.promoted_seq),
    isNull(SessionInputTable.withdrawn_seq),
  )

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.withdrawn_seq),
        eq(SessionInputTable.delivery, delivery),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
  },
) => input.delivery === expected.delivery && matchesPrompt(input, expected)

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

const matchesProjection = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
  },
) =>
  equivalent(input, expected) &&
  DateTime.toEpochMillis(input.timeCreated) === DateTime.toEpochMillis(expected.timeCreated)

const publish = Effect.fn("SessionInput.publish")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
) {
  let published = 0
  for (const row of rows) {
    if (yield* publishRow(db, events, sessionID, row)) published++
  }
  return published
})

// Promotion reads pending rows outside the promotion transaction, so a withdraw or revise may commit in between.
// The projection rejects the stale promotion; re-read the row to skip withdrawn inputs or promote the revised prompt.
const publishRow = (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  row: typeof SessionInputTable.$inferSelect,
): Effect.Effect<boolean> => {
  const id = SessionMessage.ID.make(row.id)
  return events
    .publish(SessionEvent.Prompted, {
      sessionID,
      timestamp: DateTime.makeUnsafe(row.time_created),
      messageID: id,
      prompt: decodePrompt(row.prompt),
      delivery: row.delivery,
    })
    .pipe(
      Effect.as(true),
      Effect.catchDefect((defect) => {
        if (!(defect instanceof LifecycleConflict)) return Effect.die(defect)
        return db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.id, id))
          .get()
          .pipe(
            Effect.orDie,
            Effect.flatMap((stored) => {
              if (stored?.promoted_seq !== null && stored?.promoted_seq !== undefined) return Effect.succeed(false)
              if (stored?.withdrawn_seq !== null && stored?.withdrawn_seq !== undefined) return Effect.succeed(false)
              if (stored === undefined || stored.prompt === row.prompt) return Effect.die(defect)
              return publishRow(db, events, sessionID, stored)
            }),
          )
      }),
    )
}

export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.withdrawn_seq),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return yield* publish(db, events, sessionID, rows)
})

export const promoteNextQueued: (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) => Effect.Effect<boolean> = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.withdrawn_seq),
        eq(SessionInputTable.delivery, "queue"),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return false
  // A withdraw may win the race after the read above; move on to the next queued input instead.
  if (yield* publishRow(db, events, sessionID, row)) return true
  return yield* promoteNextQueued(db, events, sessionID)
})

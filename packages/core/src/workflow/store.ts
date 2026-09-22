export * as WorkflowRunStore from "./store"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import type { SessionSchema } from "../session/schema"
import { WorkflowRunTable, type WorkflowJournalEntry } from "./sql"

type DatabaseService = Database.Interface["db"]

export type Run = {
  readonly id: string
  readonly sessionID: SessionSchema.ID | undefined
  readonly directory: string
  readonly name: string
  readonly status: "running" | "completed" | "failed" | "cancelled"
  readonly journal: ReadonlyArray<WorkflowJournalEntry>
  readonly result: unknown
  readonly error: string | undefined
  readonly resumeOf: string | undefined
}

const fromRow = (row: typeof WorkflowRunTable.$inferSelect): Run => ({
  id: row.id,
  sessionID: row.session_id ?? undefined,
  directory: row.directory,
  name: row.name,
  status: row.status,
  journal: row.journal,
  result: row.result,
  error: row.error ?? undefined,
  resumeOf: row.resume_of ?? undefined,
})

export const get = Effect.fn("WorkflowRunStore.get")(function* (db: DatabaseService, id: string) {
  const row = yield* db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).get().pipe(Effect.orDie)
  return row ? fromRow(row) : undefined
})

export const create = Effect.fn("WorkflowRunStore.create")(function* (
  db: DatabaseService,
  input: {
    readonly id: string
    readonly sessionID: SessionSchema.ID | undefined
    readonly directory: string
    readonly name: string
    readonly resumeOf: string | undefined
  },
) {
  const now = Date.now()
  yield* db
    .insert(WorkflowRunTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      directory: input.directory,
      name: input.name,
      status: "running",
      journal: [],
      resume_of: input.resumeOf,
      time_created: now,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)
})

/** Overwrites the persisted journal -- called after every live `agent()` call settles, so a crash mid-run loses at most the one in-flight call. */
export const appendJournal = Effect.fn("WorkflowRunStore.appendJournal")(function* (
  db: DatabaseService,
  id: string,
  journal: ReadonlyArray<WorkflowJournalEntry>,
) {
  yield* db
    .update(WorkflowRunTable)
    .set({ journal: [...journal], time_updated: Date.now() })
    .where(eq(WorkflowRunTable.id, id))
    .run()
    .pipe(Effect.orDie)
})

export const finish = Effect.fn("WorkflowRunStore.finish")(function* (
  db: DatabaseService,
  id: string,
  input: { readonly status: "completed" | "failed" | "cancelled"; readonly result?: unknown; readonly error?: string },
) {
  yield* db
    .update(WorkflowRunTable)
    .set({ status: input.status, result: input.result, error: input.error, time_updated: Date.now() })
    .where(eq(WorkflowRunTable.id, id))
    .run()
    .pipe(Effect.orDie)
})

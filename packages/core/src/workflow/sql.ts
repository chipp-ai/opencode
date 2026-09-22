import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import type { SessionSchema } from "../session/schema"

/** One `agent()` call's recorded position, cache key, and result within a run. */
export type WorkflowJournalEntry = {
  readonly index: number
  readonly key: { readonly prompt: string; readonly opts: unknown }
  readonly result: {
    readonly sessionID: string
    readonly text: string
    readonly structured?: Record<string, unknown>
    readonly cost: number
  }
}

/**
 * Standalone audit/resume log for workflow runs. `session_id` is a plain column, not a foreign
 * key, matching the pattern in the abandoned upstream community implementation (verified reusable
 * as-is): it records which session attributes this run's cost for the rollup, but nothing
 * requires that id to resolve, so this table survives independently of session lifecycle.
 */
export const WorkflowRunTable = sqliteTable("workflow_run", {
  id: text().primaryKey(),
  session_id: text().$type<SessionSchema.ID>(),
  directory: text().notNull(),
  name: text().notNull(),
  status: text().$type<"running" | "completed" | "failed" | "cancelled">().notNull(),
  journal: text({ mode: "json" }).notNull().$type<WorkflowJournalEntry[]>(),
  result: text({ mode: "json" }).$type<unknown>(),
  error: text(),
  resume_of: text(),
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
})

export * as Workflow from "./workflow"

import { Schema } from "effect"
import { AbsolutePath, optional } from "./schema"

export const ID = Schema.String.pipe(Schema.brand("Workflow.ID"))
export type ID = typeof ID.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Schema.String,
  description: Schema.String,
  path: AbsolutePath,
}).annotate({ identifier: "Workflow.Info" })

/** One `.opencode/workflows/*.js` file that failed metadata parsing -- reported alongside a successful `list`, not in place of it. */
export interface LintError extends Schema.Schema.Type<typeof LintError> {}
export const LintError = Schema.Struct({
  path: AbsolutePath,
  message: Schema.String,
}).annotate({ identifier: "Workflow.LintError" })

export const RunStatus = Schema.Literals(["running", "completed", "failed", "cancelled"])
export type RunStatus = typeof RunStatus.Type

export interface Run extends Schema.Schema.Type<typeof Run> {}
export const Run = Schema.Struct({
  id: Schema.String,
  status: RunStatus,
  result: optional(Schema.Unknown),
  error: optional(Schema.String),
  resumeOf: optional(Schema.String),
}).annotate({ identifier: "Workflow.Run" })

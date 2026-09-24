export * as PromptInput from "./prompt-input"

import { Schema } from "effect"
import { AgentAttachment, Format, Source } from "./prompt"
import { Model } from "./model"
import { optional, statics } from "./schema"

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "PromptInput.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) => schema.make(input),
    })),
  )

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  format: Format.pipe(optional),
  /** Serves only this prompt's turns with this agent; the Session's own agent is unchanged. */
  agentOverride: Schema.String.pipe(optional),
  /** Serves only this prompt's turns with this model; the Session's own model is unchanged. */
  modelOverride: Model.Ref.pipe(optional),
}).annotate({ identifier: "PromptInput" })

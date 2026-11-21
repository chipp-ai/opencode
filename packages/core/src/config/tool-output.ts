export * as ConfigToolOutput from "./tool-output"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.ToolOutput")({
  max_lines: PositiveInt.pipe(Schema.optional),
  max_bytes: PositiveInt.pipe(Schema.optional),
  preview: Schema.Literals(["head", "head_tail"]).pipe(Schema.optional),
  max_attachments: NonNegativeInt.pipe(Schema.optional),
  max_instruction_bytes: PositiveInt.pipe(Schema.optional),
}) {}

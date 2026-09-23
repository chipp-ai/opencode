export * as ConfigAgent from "./agent"

import { Schema } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import { ConfigProvider } from "./provider"
import { PositiveInt } from "../schema"

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

export class Info extends Schema.Class<Info>("ConfigV2.Agent")({
  model: Schema.String.pipe(Schema.optional),
  fallback: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description:
      "Ordered provider/model fallbacks tried when the selected model fails with a retryable, quota, or transport error",
  }),
  fallbackCircular: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Once every model in `fallback` has failed, try the model that started the chain again before giving up",
  }),
  variant: Schema.String.pipe(Schema.optional),
  request: ConfigProvider.Request.pipe(Schema.optional),
  system: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  mode: Schema.Literals(["subagent", "primary", "all"]).pipe(Schema.optional),
  hidden: Schema.Boolean.pipe(Schema.optional),
  color: Color.pipe(Schema.optional),
  steps: PositiveInt.pipe(Schema.optional),
  disabled: Schema.Boolean.pipe(Schema.optional),
  permissions: Permission.Ruleset.pipe(Schema.optional),
}) {}

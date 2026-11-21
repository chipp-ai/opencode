import { Effect, Layer } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { EventPersistPolicy } from "@opencode-ai/core/event/persist-policy"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeFlags } from "./runtime-flags"

/**
 * Supplies `EventV2.Persist` for a composition root. An explicit `persist` (e.g. from an embedder calling
 * `Server.listen`) wins; otherwise `OPENCODE_EVENT_REDACT_ENABLED` selects `EventPersistPolicy.apply`; otherwise
 * durable events are stored unchanged. `deliver` supplies `EventV2.Deliver` the same way. Provide it above every
 * service graph so all compile passes see it.
 */
export const layer = (persist?: EventV2.LayerOptions["persist"], deliver?: EventV2.Deliver) =>
  Layer.mergeAll(
    Layer.effect(
      EventV2.Persist,
      Effect.gen(function* () {
        const flags = yield* RuntimeFlags.Service
        return persist ?? (flags.eventRedact ? EventPersistPolicy.apply : undefined)
      }),
    ).pipe(Layer.provide(LayerNode.compile(RuntimeFlags.node))),
    Layer.succeed(EventV2.Deliver, deliver),
  )

export * as EventPersist from "./event-persist"

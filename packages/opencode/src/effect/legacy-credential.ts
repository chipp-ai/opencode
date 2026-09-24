import { Effect, Layer, Record, Result } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Auth } from "@/auth"

/**
 * Supplies `Credential.Legacy` from the V1 auth store so V2 sessions can use API keys connected through the
 * legacy provider flow (`auth.json`). Each lookup re-reads the store, so connecting or disconnecting a provider
 * takes effect without a restart. OAuth entries are skipped: their refresh logic lives only in V1.
 * Provide it above every service graph, like `EventPersist.layer`, so all compile passes see it.
 */
export const layer = Layer.effect(
  Credential.Legacy,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    return () =>
      auth.all().pipe(
        Effect.map((entries) =>
          Record.filterMap(entries, (entry) =>
            entry.type === "api"
              ? Result.succeed(Credential.Key.make({ type: "key", key: entry.key, metadata: entry.metadata }))
              : Result.fail(undefined),
          ),
        ),
        Effect.orElseSucceed(() => ({})),
      )
  }),
).pipe(Layer.provide(LayerNode.compile(Auth.node)))

export * as LegacyCredential from "./legacy-credential"

export * as ConfigProviderDiscoveryPlugin from "./provider-discovery"

import { Effect, Schedule } from "effect"
import { HttpClient } from "effect/unstable/http"
import { define } from "../../plugin/internal"
import { Config } from "../../config"
import { ProviderDiscovery } from "../../provider-discovery"

/**
 * Adds models reported by `GET {api.url}/models` for configured providers that opt in with `discover: true`.
 * Configured and models.dev entries always win; discovery only adds missing models and fills unknown limits.
 */
export const Plugin = define({
  id: "config-provider-discovery",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const http = yield* HttpClient.HttpClient
    const discovered = new Map<string, readonly ProviderDiscovery.Model[]>()

    yield* ctx.catalog.transform((catalog) => {
      for (const [providerID, models] of discovered) {
        if (!catalog.provider.get(providerID)) continue
        for (const item of models) {
          const existing = catalog.model.get(providerID, item.id)
          catalog.model.update(providerID, item.id, (model) => {
            if (!existing) {
              model.name = item.id
              model.capabilities = { tools: true, input: ["text"], output: ["text"] }
            }
            if (model.limit.context === 0 && item.context) model.limit.context = Math.trunc(item.context)
            if (model.limit.output === 0 && item.output) model.limit.output = Math.trunc(item.output)
          })
        }
      }
    })

    const load = Effect.fn("ConfigProviderDiscoveryPlugin.load")(function* () {
      const targets = targetsFrom(yield* config.entries())
      yield* Effect.forEach(
        targets,
        Effect.fnUntraced(function* (target) {
          const connection = yield* ctx.integration.connection.active(target.providerID)
          const credential = connection
            ? yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
            : undefined
          const apiKey =
            credential?.type === "key"
              ? credential.key
              : credential?.type === "oauth"
                ? credential.access
                : target.apiKey
          yield* ProviderDiscovery.models(http, { baseURL: target.baseURL, apiKey, headers: target.headers }).pipe(
            Effect.tap((models) => Effect.sync(() => discovered.set(target.providerID, models))),
            // Keep the last successful result (or nothing) so an unreachable endpoint never breaks the catalog.
            Effect.catch((error) =>
              Effect.logWarning("provider model discovery failed", {
                providerID: target.providerID,
                url: error.url,
                message: error.message,
              }),
            ),
          )
        }),
        { concurrency: "unbounded", discard: true },
      )
      const active = new Set(targets.map((target) => target.providerID))
      for (const providerID of discovered.keys()) if (!active.has(providerID)) discovered.delete(providerID)
      if (targets.length > 0) yield* ctx.catalog.reload()
    })

    // Same cadence as the models.dev refresh: run once, then every hour so newly loaded local models appear.
    yield* load().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore, Effect.forkScoped)
  }),
})

function targetsFrom(entries: readonly Config.Entry[]) {
  const merged = new Map<
    string,
    { discover?: boolean; baseURL?: string; apiKey?: string; headers: Record<string, string> }
  >()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const [providerID, item] of Object.entries(entry.info.providers ?? {})) {
      const current = merged.get(providerID) ?? { headers: {} }
      const apiKey = item.request?.body?.apiKey ?? item.api?.settings?.apiKey
      // Catalog normalizes `request.body.baseURL` into `api.url`, so honor both spellings here too.
      const baseURL = item.api?.url ?? item.request?.body?.baseURL
      merged.set(providerID, {
        discover: item.discover ?? current.discover,
        baseURL: typeof baseURL === "string" && baseURL ? baseURL : current.baseURL,
        apiKey: typeof apiKey === "string" ? apiKey : current.apiKey,
        headers: { ...current.headers, ...item.request?.headers },
      })
    }
  }
  return [...merged].flatMap(([providerID, item]) =>
    item.discover && item.baseURL
      ? [{ providerID, baseURL: item.baseURL, apiKey: item.apiKey, headers: item.headers }]
      : [],
  )
}

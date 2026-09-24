import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Catalog } from "@opencode-ai/core/catalog"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginInternal } from "@opencode-ai/core/plugin/internal"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const locations = yield* LocationServiceMap.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const runnable = Effect.fn("ConfigHttpApi.runnable")(function* () {
      const plugins = yield* PluginV2.Service
      const catalog = yield* Catalog.Service
      yield* plugins.wait(PluginInternal.BootedID)
      return new Set(
        (yield* catalog.model.available())
          .filter(SessionRunnerModel.supported)
          .map((model) => `${model.providerID}/${model.id}`),
      )
    })

    // Opt-in per caller: the TUI model picker feeds V2 sessions, so it must only offer models the V2 runner can
    // resolve. Other callers (ACP, V1 sessions) run through the V1 provider stack and keep the full list.
    const providers = Effect.fn("ConfigHttpApi.providers")(function* (ctx: { query: { runner?: "v2" } }) {
      const all = yield* providerSvc.list()
      if (ctx.query.runner !== "v2" || !flags.experimentalV2Session) return listed(all)
      const allowed = yield* runnable().pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
      return listed(
        Object.fromEntries(
          Object.entries(all).flatMap(([id, provider]) => {
            const models = Object.fromEntries(
              Object.entries(provider.models).filter(([modelID]) => allowed.has(`${id}/${modelID}`)),
            )
            return Object.keys(models).length === 0 ? [] : [[id, { ...provider, models }]]
          }),
        ),
      )
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
).pipe(Layer.provide(locationServiceMapLayer))

function listed(providers: Record<string, Provider.Info>) {
  return {
    providers: Object.values(providers).map(Provider.toPublicInfo),
    default: Provider.defaultModelIDs(providers),
  }
}

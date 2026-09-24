import type { Config as EffectConfig } from "effect"
import { Layer } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiGroup } from "effect/unstable/httpapi"
import type { HttpApiApp } from "./server"

// Composition-time extension point: an embedder passes extensions to
// `HttpApiApp.createRoutes(cors, extensions)` or `Server.listen({ routeExtensions })`.
// Each extension is a standalone `HttpApi` (like `PtyConnectApi`), so it owns its
// middleware stack instead of inheriting `RootHttpApi`'s `Authorization`.
export type RouteExtension = Layer.Layer<never, EffectConfig.ConfigError, HttpApiApp.RouteExtensionServices>

// `middleware` is required so every extension picks its auth boundary explicitly:
// its own `HttpApiMiddleware.Service` implementation, `HttpApiApp.httpApiAuthLayer`
// to reuse the main server auth, or `Layer.empty` for an intentionally public API.
export function make<Id extends string, Groups extends HttpApiGroup.Any, EH, RH, M, EM, RM>(input: {
  readonly api: HttpApi.HttpApi<Id, Groups>
  readonly handlers: Layer.Layer<HttpApiGroup.ToService<Id, Groups>, EH, RH>
  readonly middleware: Layer.Layer<M, EM, RM>
}) {
  return HttpApiBuilder.layer(input.api).pipe(Layer.provide(input.handlers), Layer.provide(input.middleware))
}

export * as RouteExtension from "./extension"

import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi"
import { Database } from "@opencode-ai/core/database/database"
import { RouteExtension } from "../../src/server/routes/instance/httpapi/extension"

// Demo downstream extension: a product-specific API gated by its own header token,
// independent of the main server's Basic auth.
export const FactoryPaths = { ping: "/factory/ping" } as const
export const FACTORY_TOKEN_HEADER = "x-factory-token"

export class FactoryUnauthorized extends Schema.ErrorClass<FactoryUnauthorized>("FactoryUnauthorized")(
  { name: Schema.Literal("FactoryUnauthorized") },
  { httpApiStatus: 401 },
) {}

export class FactoryAuthorization extends HttpApiMiddleware.Service<FactoryAuthorization>()(
  "@opencode/test/FactoryAuthorization",
  { error: FactoryUnauthorized },
) {}

export const FactoryApi = HttpApi.make("factory").add(
  HttpApiGroup.make("factory")
    .add(
      HttpApiEndpoint.get("ping", FactoryPaths.ping, {
        success: Schema.Struct({ service: Schema.Literal("factory"), database: Schema.Boolean }),
      }),
    )
    .middleware(FactoryAuthorization),
)

export function factoryExtension(token: string) {
  return RouteExtension.make({
    api: FactoryApi,
    handlers: HttpApiBuilder.group(FactoryApi, "factory", (handlers) =>
      Effect.gen(function* () {
        // Proves extensions can consume services owned by the main server composition.
        const database = yield* Database.Service
        return handlers.handle("ping", () =>
          Effect.succeed({ service: "factory" as const, database: database.db !== undefined }),
        )
      }),
    ),
    middleware: Layer.succeed(FactoryAuthorization)((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.headers[FACTORY_TOKEN_HEADER] === token) return yield* effect
        return yield* new FactoryUnauthorized({ name: "FactoryUnauthorized" })
      }),
    ),
  })
}

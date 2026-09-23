import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ConfigProviderPlugin } from "@opencode-ai/core/config/plugin/provider"
import { ConfigProviderDiscoveryPlugin } from "@opencode-ai/core/config/plugin/provider-discovery"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

const decode = Schema.decodeUnknownSync(Config.Info)
const providerID = ProviderV2.ID.make("local")

function configOf(...documents: unknown[]) {
  return Config.Service.of({
    entries: () =>
      Effect.succeed(documents.map((info) => new Config.Document({ type: "document", info: decode(info) }))),
  })
}

function client(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const requests: HttpClientRequest.HttpClientRequest[] = []
  return {
    requests,
    http: HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request)
        return HttpClientResponse.fromWeb(request, handler(request))
      }),
    ),
  }
}

const addPlugins = Effect.fn(function* (config: Config.Interface, http: HttpClient.HttpClient) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
  yield* ConfigProviderDiscoveryPlugin.Plugin.effect(host).pipe(
    Effect.provideService(Config.Service, config),
    Effect.provideService(HttpClient.HttpClient, http),
  )
})

function eventually<A>(
  effect: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  remaining = 1000,
): Effect.Effect<A, Error> {
  return Effect.gen(function* () {
    const value = yield* effect
    if (predicate(value)) return value
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for value"))
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* eventually(effect, predicate, remaining - 1)
  })
}

const localProvider = {
  api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "http://localhost:1234/v1" },
  request: { body: { apiKey: "local-key" } },
}

describe("ConfigProviderDiscoveryPlugin.Plugin", () => {
  it.live("adds discovered models alongside configured ones without overriding them", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const fake = client(() =>
        Response.json({
          data: [
            { id: "configured", context_length: 131072, max_output_tokens: 8192 },
            { id: "qwen2.5-coder", context_length: 32768, max_output_tokens: 4096 },
            { id: "llama-3.1-8b" },
          ],
        }),
      )
      yield* addPlugins(
        configOf({
          providers: {
            local: {
              ...localProvider,
              discover: true,
              models: { configured: { name: "Configured", limit: { context: 1000, output: 100 } } },
            },
          },
        }),
        fake.http,
      )

      const models = yield* eventually(
        catalog.model.all().pipe(Effect.map((items) => items.filter((item) => item.providerID === providerID))),
        (items) => items.length === 3,
      )
      const byID = Object.fromEntries(models.map((model) => [model.id, model]))
      expect(byID["configured"]?.name).toBe("Configured")
      expect(byID["configured"]?.limit).toMatchObject({ context: 1000, output: 100 })
      expect(byID["qwen2.5-coder"]).toMatchObject({
        name: "qwen2.5-coder",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 32768, output: 4096 },
        api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "http://localhost:1234/v1" },
      })
      expect(byID["llama-3.1-8b"]?.limit).toMatchObject({ context: 0, output: 0 })
      expect(fake.requests[0]?.url).toBe("http://localhost:1234/v1/models")
      expect(fake.requests[0]?.headers.authorization).toBe("Bearer local-key")
    }),
  )

  it.live("keeps configured models when the discovery endpoint fails", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const fake = client(() => new Response("nope", { status: 500 }))
      yield* addPlugins(
        configOf({ providers: { local: { ...localProvider, discover: true, models: { configured: {} } } } }),
        fake.http,
      )
      yield* eventually(
        Effect.sync(() => fake.requests.length),
        (count) => count > 0,
      )
      yield* Effect.promise(() => Bun.sleep(10))
      expect(yield* catalog.provider.get(providerID)).toBeDefined()
      expect(
        (yield* catalog.model.all()).filter((item) => item.providerID === providerID).map((item) => item.id),
      ).toEqual([ModelV2.ID.make("configured")])
    }),
  )

  it.live("does not call the endpoint unless discovery is enabled", () =>
    Effect.gen(function* () {
      const fake = client(() => Response.json({ data: [{ id: "x" }] }))
      yield* addPlugins(configOf({ providers: { local: localProvider } }), fake.http)
      yield* Effect.promise(() => Bun.sleep(10))
      expect(fake.requests).toHaveLength(0)
    }),
  )

  it.live("merges discover flag and base URL across layered config documents", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const fake = client(() => Response.json({ data: [{ id: "layered" }] }))
      yield* addPlugins(
        configOf({ providers: { local: localProvider } }, { providers: { local: { discover: true } } }),
        fake.http,
      )
      yield* eventually(catalog.model.get(providerID, ModelV2.ID.make("layered")), (model) => model !== undefined)
      expect(fake.requests[0]?.url).toBe("http://localhost:1234/v1/models")
    }),
  )
})

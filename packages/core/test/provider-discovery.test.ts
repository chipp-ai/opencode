import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ProviderDiscovery } from "@opencode-ai/core/provider-discovery"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

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

describe("ProviderDiscovery.url", () => {
  it.effect("appends /models to the configured base URL, keeping subpaths", () =>
    Effect.sync(() => {
      expect(ProviderDiscovery.url("http://localhost:1234/v1")).toBe("http://localhost:1234/v1/models")
      expect(ProviderDiscovery.url("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1/models")
      expect(ProviderDiscovery.url("https://host/api/v1")).toBe("https://host/api/v1/models")
    }),
  )
})

describe("ProviderDiscovery.models", () => {
  it.effect("parses ids and optional limits and sends auth headers", () =>
    Effect.gen(function* () {
      const fake = client(() =>
        Response.json({
          object: "list",
          data: [
            { id: "llama-3.1-8b", object: "model", context_length: 131072, max_output_tokens: 8192 },
            { id: "mistral-7b", object: "model", max_context_length: 32768 },
            { id: "qwen", object: "model", max_model_len: 4096 },
            { id: "llama-3.1-8b", object: "model" },
            { id: "  ", object: "model" },
          ],
        }),
      )
      const models = yield* ProviderDiscovery.models(fake.http, {
        baseURL: "http://localhost:1234/v1",
        apiKey: "secret",
        headers: { "X-Extra": "1" },
      })
      expect(models).toEqual([
        { id: "llama-3.1-8b", context: 131072, output: 8192 },
        { id: "mistral-7b", context: 32768, output: undefined },
        { id: "qwen", context: 4096, output: undefined },
      ])
      expect(fake.requests[0]?.url).toBe("http://localhost:1234/v1/models")
      expect(fake.requests[0]?.headers.authorization).toBe("Bearer secret")
      expect(fake.requests[0]?.headers["x-extra"]).toBe("1")
    }),
  )

  it.effect("omits the authorization header when no key is configured", () =>
    Effect.gen(function* () {
      const fake = client(() => Response.json({ data: [] }))
      expect(yield* ProviderDiscovery.models(fake.http, { baseURL: "http://localhost:1234/v1" })).toEqual([])
      expect(fake.requests[0]?.headers.authorization).toBeUndefined()
    }),
  )

  it.effect("fails with DiscoveryError on non-2xx, non-JSON, and malformed bodies", () =>
    Effect.gen(function* () {
      const responses = [
        new Response("unauthorized", { status: 401 }),
        new Response("<html>error</html>", { headers: { "content-type": "text/html" } }),
        Response.json({ models: ["a"] }),
      ]
      for (const response of responses) {
        const exit = yield* ProviderDiscovery.models(client(() => response).http, {
          baseURL: "http://localhost:1234/v1",
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("ProviderDiscovery.Error")
      }
    }),
  )
})

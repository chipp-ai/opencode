import { afterAll, afterEach, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// A real local OpenAI-compatible `/v1/models` endpoint; each provider ID gets its own response.
const requests: { path: string; authorization: string | null }[] = []
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    requests.push({ path, authorization: request.headers.get("authorization") })
    if (path === "/ok/v1/models")
      return Response.json({
        object: "list",
        data: [
          { id: "configured", object: "model", context_length: 131072, max_output_tokens: 8192 },
          { id: "qwen2.5-coder", object: "model", context_length: 32768, max_output_tokens: 4096 },
          { id: "llama-3.1-8b", object: "model" },
          { id: "blocked", object: "model" },
        ],
      })
    if (path === "/html/v1/models")
      return new Response("<html>error</html>", { headers: { "content-type": "text/html" } })
    return new Response("unavailable", { status: 503 })
  },
})

afterAll(() => server.stop(true))
afterEach(async () => {
  requests.length = 0
  await disposeAllInstances()
})

const it = testEffect(LayerNode.compile(Provider.node))
const list = Provider.use.list()
const local = ProviderV2.ID.make("local")
const base = (path: string) => `http://127.0.0.1:${server.port}/${path}/v1`

it.instance(
  "discoverModels adds models from /models and keeps configured model settings",
  () =>
    Effect.gen(function* () {
      const provider = (yield* list)[local]
      expect(provider).toBeDefined()
      expect(Object.keys(provider.models).toSorted()).toEqual(["configured", "llama-3.1-8b", "qwen2.5-coder"])
      expect(provider.models["configured"].name).toBe("My Model")
      expect(provider.models["configured"].limit).toMatchObject({ context: 1000, output: 100 })
      expect(provider.models["qwen2.5-coder"]).toMatchObject({
        name: "qwen2.5-coder",
        api: { id: "qwen2.5-coder", npm: "@ai-sdk/openai-compatible", url: base("ok") },
        limit: { context: 32768, output: 4096 },
        capabilities: { toolcall: true, attachment: false },
      })
      expect(provider.models["llama-3.1-8b"].limit).toMatchObject({ context: 0, output: 0 })
      expect(provider.models["qwen2.5-coder"].variants).toBeDefined()
      expect(requests).toEqual([{ path: "/ok/v1/models", authorization: "Bearer local-key" }])
    }),
  {
    config: () => ({
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          discoverModels: true,
          blacklist: ["blocked"],
          options: { baseURL: base("ok"), apiKey: "local-key" },
          models: { configured: { name: "My Model", limit: { context: 1000, output: 100 } } },
        },
      },
    }),
  },
)

it.instance(
  "discovery failure keeps statically configured models",
  () =>
    Effect.gen(function* () {
      const provider = (yield* list)[local]
      expect(provider).toBeDefined()
      expect(Object.keys(provider.models)).toEqual(["configured"])
      expect(requests).toHaveLength(1)
    }),
  {
    config: () => ({
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          discoverModels: true,
          options: { baseURL: base("down") },
          models: { configured: {} },
        },
      },
    }),
  },
)

it.instance(
  "non-JSON discovery response does not break provider loading",
  () =>
    Effect.gen(function* () {
      const providers = yield* list
      // No static models and nothing discovered: the provider is dropped like any other empty provider.
      expect(providers[local]).toBeUndefined()
      expect(requests).toHaveLength(1)
    }),
  {
    config: () => ({
      provider: {
        local: { npm: "@ai-sdk/openai-compatible", discoverModels: true, options: { baseURL: base("html") } },
      },
    }),
  },
)

it.instance(
  "providers without discoverModels never call /models",
  () =>
    Effect.gen(function* () {
      const provider = (yield* list)[local]
      expect(Object.keys(provider.models)).toEqual(["configured"])
      expect(requests).toHaveLength(0)
    }),
  {
    config: () => ({
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: base("ok") },
          models: { configured: {} },
        },
      },
    }),
  },
)

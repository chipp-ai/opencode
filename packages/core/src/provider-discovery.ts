export * as ProviderDiscovery from "./provider-discovery"

import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

// `context_length`, `max_context_length`, `max_model_len` and `max_output_tokens` are non-standard
// extensions reported by llama.cpp/llama-swap, LM Studio and vLLM; plain OpenAI only returns `id`.
const Limit = Schema.optional(Schema.NullOr(Schema.Finite))
const ModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      context_length: Limit,
      max_context_length: Limit,
      max_model_len: Limit,
      max_output_tokens: Limit,
    }),
  ),
})

export type Model = {
  readonly id: string
  readonly context?: number
  readonly output?: number
}

export class DiscoveryError extends Schema.TaggedErrorClass<DiscoveryError>()("ProviderDiscovery.Error", {
  url: Schema.String,
  message: Schema.String,
}) {}

export type Input = {
  readonly baseURL: string
  readonly apiKey?: string
  readonly headers?: Readonly<Record<string, string>>
}

/** Mirrors how OpenAI-compatible SDKs join `baseURL` with `/chat/completions`, so subpaths like `/api/v1` are kept. */
export function url(baseURL: string) {
  return `${baseURL.trim().replace(/\/+$/, "")}/models`
}

/** Lists models from an OpenAI-compatible `GET {baseURL}/models` endpoint. */
export const models = Effect.fn("ProviderDiscovery.models")(function* (http: HttpClient.HttpClient, input: Input) {
  const target = url(input.baseURL)
  const response = yield* HttpClientRequest.get(target).pipe(
    HttpClientRequest.acceptJson,
    (request) => (input.apiKey ? HttpClientRequest.bearerToken(request, input.apiKey) : request),
    // Explicit headers win over the bearer token, matching @ai-sdk/openai-compatible.
    HttpClientRequest.setHeaders(input.headers ?? {}),
    http.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ModelList)),
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) => new DiscoveryError({ url: target, message: cause.message })),
  )
  return response.data
    .filter((item, index) => item.id.trim() !== "" && response.data.findIndex((x) => x.id === item.id) === index)
    .map(
      (item): Model => ({
        id: item.id,
        context: item.context_length ?? item.max_context_length ?? item.max_model_len ?? undefined,
        output: item.max_output_tokens ?? undefined,
      }),
    )
})

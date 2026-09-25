export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { type Model } from "@opencode-ai/llm"
import * as AnthropicMessages from "@opencode-ai/llm/protocols/anthropic-messages"
import * as CohereChat from "@opencode-ai/llm/protocols/cohere-chat"
import * as Gemini from "@opencode-ai/llm/protocols/gemini"
import * as OpenAICompatibleChat from "@opencode-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { OpenRouter } from "@opencode-ai/llm/providers"
import { Auth, type AnyRoute } from "@opencode-ai/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<{ model: Model; info: ModelV2.Info }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  const native = nativeRoute(resolved)
  if (!native)
    return Effect.fail(
      new UnsupportedApiError({
        providerID: resolved.providerID,
        modelID: resolved.id,
        api: apiName(resolved),
      }),
    )
  return Effect.succeed(
    withDefaults(resolved, native.route)
      .with({ auth: key === undefined ? Auth.none : native.auth(key) })
      .model({ id: resolved.api.id }),
  )
}

// OpenAI-chat-compatible catalog packages that route through the generic
// OpenAICompatibleChat protocol. Each is documented by its vendor as a
// genuine OpenAI Chat Completions-compatible endpoint (request/response
// shape, streaming, and tool-calling) — see nativeRoute's doc comment for
// packages deliberately left out of this list (Mistral, Perplexity) because
// they were found NOT to satisfy that bar.
const OPENAI_COMPATIBLE_PACKAGES = new Set([
  "@ai-sdk/openai-compatible",
  "@ai-sdk/groq",
  "@ai-sdk/cerebras",
  "@ai-sdk/deepinfra",
  "@ai-sdk/togetherai",
])

/**
 * The single allowlist of catalog APIs the native runner can call; `supported` and `fromCatalogModel` both derive from it.
 *
 * Deliberately NOT included (each investigated, not just deferred):
 * - `@ai-sdk/mistral`: Mistral's own OpenAPI-generated client marks streamed
 *   `tool_calls[].index` as optional, while the shared OpenAI Chat protocol
 *   requires it — a real divergence that can hard-fail or corrupt multi-tool
 *   turns, not a hypothetical one.
 * - `@ai-sdk/perplexity`: its chat completions endpoint has no tool/function
 *   calling support at all, which the native runner's agentic tool loop
 *   requires.
 * - `ai-gateway-provider` (Cloudflare AI Gateway): needs an accountId/gatewayId
 *   pair to build its base URL that no V2 catalog transform resolves into
 *   `model.api.url` today, and its real auth model needs a `cf-aig-authorization`
 *   gateway secret plus, for non-Workers-AI upstreams, a second independent
 *   upstream provider bearer token — two credentials `Credential.Value` cannot
 *   represent for one model.
 * - `@ai-sdk/azure`: the resource name lives in a separate `resourceName`
 *   config field (never folded into `model.api.url`, unlike Cloudflare Workers
 *   AI's catalog transform), its real routes require a mandatory `api-version`
 *   query param this allowlist has no way to attach generically, and its OAuth
 *   (Azure CLI) auth mode needs a dynamic per-request token refresh that
 *   `Credential.Value` cannot express — the same class of exclusion as GitHub
 *   Copilot's OAuth.
 * - `@ai-sdk/amazon-bedrock`: needs AWS SigV4 signing with a 3-part credential
 *   (access key, secret, optional session token) `Credential.Value` doesn't
 *   represent today.
 * - `github-copilot`: needs OAuth device-flow + refresh, which V2's
 *   `Credential.Legacy` bridge deliberately excludes (refresh logic lives
 *   only in V1).
 * - `@ai-sdk/google-vertex` / `@ai-sdk/google-vertex-anthropic`: needs GCP
 *   service-account/ADC auth, a third distinct credential shape.
 * - Out of scope entirely for this pass (no existing `packages/llm` route,
 *   not requested): GitLab, Watsonx, Venice, Salad Cloud, merge-gateway,
 *   aihubmix, qvac, and any other catalog package not named above.
 */
const nativeRoute = (model: ModelV2.Info) => {
  if (model.api.type !== "aisdk") return
  if (model.api.package === "@ai-sdk/openai") return { route: OpenAIResponses.route, auth: Auth.bearer }
  if (model.api.package === "@ai-sdk/anthropic")
    return { route: AnthropicMessages.route, auth: Auth.header("x-api-key") }
  if (OPENAI_COMPATIBLE_PACKAGES.has(model.api.package) && model.api.url)
    return { route: OpenAICompatibleChat.route, auth: Auth.bearer }
  // OpenRouter speaks OpenAI Chat; its dedicated route keeps OpenRouter-only body options (usage, reasoning, prompt_cache_key).
  if (model.api.package === "@openrouter/ai-sdk-provider") return { route: OpenRouter.route, auth: Auth.bearer }
  if (model.api.package === "@ai-sdk/google") return { route: Gemini.route, auth: Auth.header("x-goog-api-key") }
  // xAI's Grok models speak the OpenAI Responses API natively (the golden recorded
  // test exercises `xai.model(...)`, which resolves to XAI's `responses` route).
  if (model.api.package === "@ai-sdk/xai") return { route: OpenAIResponses.route, auth: Auth.bearer }
  // Cohere's Chat v2 API is not OpenAI-shaped; see protocols/cohere-chat.ts.
  if (model.api.package === "@ai-sdk/cohere") return { route: CohereChat.route, auth: Auth.bearer }
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  withVariant(model, session.model?.variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential)))

export const supported = (model: ModelV2.Info) => nativeRoute(model) !== undefined

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        const model = yield* resolve(
          session,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
        )
        return { model, info: selected }
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [Catalog.node, Integration.node] })

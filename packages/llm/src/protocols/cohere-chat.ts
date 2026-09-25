import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolContent,
  type ToolDefinition,
} from "../schema"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"
import { ToolStream } from "./utils/tool-stream"

const ADAPTER = "cohere-chat"
export const DEFAULT_BASE_URL = "https://api.cohere.com"
export const PATH = "/v2/chat"

// =============================================================================
// Request Body Schema
// =============================================================================
// Cohere's v2 Chat API is not OpenAI-shaped: tool results are wrapped `document`
// blocks (not plain text), tool choice is a two-value enum (no per-tool
// forcing), and reasoning round-trips through a distinct top-level
// `tool_plan` field on the assistant message rather than message content.
// https://docs.cohere.com/reference/chat
const CohereFunction = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
})

const CohereTool = Schema.Struct({
  type: Schema.tag("function"),
  function: CohereFunction,
})
type CohereTool = Schema.Schema.Type<typeof CohereTool>

const CohereToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.tag("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
})
type CohereToolCall = Schema.Schema.Type<typeof CohereToolCall>

// Tool results are documents, not plain text — Cohere's citation machinery
// keys off this shape. `id` is optional; Cohere auto-generates one when omitted.
const CohereDocument = Schema.Struct({
  type: Schema.tag("document"),
  document: Schema.Struct({ data: Schema.String }),
})

const CohereMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: optionalNull(Schema.String),
    tool_plan: Schema.optional(Schema.String),
    tool_calls: optionalArray(CohereToolCall),
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    tool_call_id: Schema.String,
    content: Schema.Array(CohereDocument),
  }),
]).pipe(Schema.toTaggedUnion("role"))
type CohereMessage = Schema.Schema.Type<typeof CohereMessage>

// Cohere's tool_choice is a two-value enum with no per-tool forcing — unlike
// OpenAI's `{type: "function", function: {name}}` shape, there is no wire
// representation for `ToolChoice.named(...)`; `lowerToolChoice` rejects it.
const CohereToolChoice = Schema.Literals(["REQUIRED", "NONE"])

export const bodyFields = {
  model: Schema.String,
  messages: Schema.Array(CohereMessage),
  tools: optionalArray(CohereTool),
  tool_choice: Schema.optional(CohereToolChoice),
  stream: Schema.Literal(true),
  temperature: Schema.optional(Schema.Number),
  max_tokens: Schema.optional(Schema.Number),
  p: Schema.optional(Schema.Number),
  k: Schema.optional(Schema.Number),
  stop_sequences: optionalArray(Schema.String),
}
const CohereChatBody = Schema.Struct(bodyFields)
export type CohereChatBody = Schema.Schema.Type<typeof CohereChatBody>

// =============================================================================
// Streaming Event Schema
// =============================================================================
// https://docs.cohere.com/reference/chat-stream — every event is
// `{ type, index?, delta? }`. `index` distinguishes parallel content blocks
// and tool calls; it is only present when more than one is in flight, so
// parsing defaults it to 0.
const CohereUsage = Schema.Struct({
  billed_units: optionalNull(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
    }),
  ),
  tokens: optionalNull(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
    }),
  ),
})
type CohereUsage = Schema.Schema.Type<typeof CohereUsage>

const CohereStreamContent = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
})

const CohereStreamToolCall = Schema.Struct({
  id: Schema.optional(Schema.String),
  function: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.String),
    }),
  ),
})

const CohereStreamMessage = Schema.Struct({
  content: Schema.optional(CohereStreamContent),
  tool_plan: Schema.optional(Schema.String),
  tool_calls: Schema.optional(CohereStreamToolCall),
})

const CohereStreamDelta = Schema.Struct({
  message: Schema.optional(CohereStreamMessage),
  finish_reason: optionalNull(Schema.String),
  usage: Schema.optional(CohereUsage),
})

const CohereEvent = Schema.Struct({
  type: Schema.String,
  index: Schema.optional(Schema.Number),
  delta: Schema.optional(CohereStreamDelta),
})
type CohereEvent = Schema.Schema.Type<typeof CohereEvent>
type CohereRequestMessage = LLMRequest["messages"][number]

interface ParserState {
  readonly tools: ToolStream.State<number>
  readonly usage?: Usage
  readonly lifecycle: Lifecycle.State
}

const invalid = ProviderShared.invalidRequest

// =============================================================================
// Request Lowering
// =============================================================================
const lowerTool = (tool: ToolDefinition, inputSchema: JsonSchema): CohereTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: ToolSchemaProjection.openAI(inputSchema),
  },
})

const lowerToolChoice = Effect.fn("CohereChat.lowerToolChoice")(function* (
  toolChoice: NonNullable<LLMRequest["toolChoice"]>,
) {
  if (toolChoice.type === "auto") return undefined
  if (toolChoice.type === "none") return "NONE" as const
  if (toolChoice.type === "required") return "REQUIRED" as const
  return yield* invalid(
    `Cohere Chat does not support forcing a specific tool (requested "${toolChoice.name}"); only auto, none, and required tool choice are supported`,
  )
})

const lowerToolCall = (part: ToolCallPart): CohereToolCall => ({
  id: part.id,
  type: "function",
  function: {
    name: part.name,
    arguments: ProviderShared.encodeJson(part.input),
  },
})

const lowerUserMessage = Effect.fn("CohereChat.lowerUserMessage")(function* (message: CohereRequestMessage) {
  const content: TextPart[] = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["text"]))
      return yield* ProviderShared.unsupportedContent("Cohere Chat", "user", ["text"])
    content.push(part)
  }
  return { role: "user" as const, content: ProviderShared.joinText(content) }
})

const lowerAssistantMessage = Effect.fn("CohereChat.lowerAssistantMessage")(function* (
  message: CohereRequestMessage,
) {
  const content: TextPart[] = []
  const reasoning: ReasoningPart[] = []
  const toolCalls: CohereToolCall[] = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
      return yield* ProviderShared.unsupportedContent("Cohere Chat", "assistant", ["text", "reasoning", "tool-call"])
    if (part.type === "text") {
      content.push(part)
      continue
    }
    if (part.type === "reasoning") {
      reasoning.push(part)
      continue
    }
    toolCalls.push(lowerToolCall(part))
  }
  return {
    role: "assistant" as const,
    content: content.length === 0 ? undefined : ProviderShared.joinText(content),
    tool_plan: reasoning.length === 0 ? undefined : reasoning.map((part) => part.text).join(""),
    tool_calls: toolCalls.length === 0 ? undefined : toolCalls,
  }
})

const lowerToolResultItem = Effect.fn("CohereChat.lowerToolResultItem")(function* (item: ToolContent) {
  if (item.type === "text") return item.text
  return yield* ProviderShared.invalidRequest("Cohere Chat tool results only support text content for now")
})

const lowerToolMessage = Effect.fn("CohereChat.lowerToolMessage")(function* (message: CohereRequestMessage) {
  const messages: CohereMessage[] = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["tool-result"]))
      return yield* ProviderShared.unsupportedContent("Cohere Chat", "tool", ["tool-result"])
    if (part.result.type !== "content") {
      messages.push({
        role: "tool",
        tool_call_id: part.id,
        content: [{ type: "document", document: { data: ProviderShared.toolResultText(part) } }],
      })
      continue
    }
    // Preserve the narrowed array element type when compiled through a consumer package.
    const content: ReadonlyArray<ToolContent> = part.result.value
    const text = (yield* Effect.forEach(content, lowerToolResultItem)).join("\n")
    messages.push({ role: "tool", tool_call_id: part.id, content: [{ type: "document", document: { data: text } }] })
  }
  return messages
})

const lowerMessage = Effect.fn("CohereChat.lowerMessage")(function* (message: CohereRequestMessage) {
  if (message.role === "user") return [yield* lowerUserMessage(message)]
  if (message.role === "assistant") return [yield* lowerAssistantMessage(message)]
  return yield* lowerToolMessage(message)
})

const lowerMessages = Effect.fn("CohereChat.lowerMessages")(function* (request: LLMRequest) {
  const system: CohereMessage[] =
    request.system.length === 0 ? [] : [{ role: "system", content: ProviderShared.joinText(request.system) }]
  const messages = [...system]
  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("Cohere Chat", message)
      messages.push({ role: "user", content: part.text })
      continue
    }
    messages.push(...(yield* lowerMessage(message)))
  }
  return messages
})

const fromRequest = Effect.fn("CohereChat.fromRequest")(function* (request: LLMRequest) {
  const generation = request.generation
  return {
    model: request.model.id,
    messages: yield* lowerMessages(request),
    tools: request.tools.length === 0 ? undefined : request.tools.map((tool) => lowerTool(tool, tool.inputSchema)),
    tool_choice: request.toolChoice ? yield* lowerToolChoice(request.toolChoice) : undefined,
    stream: true as const,
    temperature: generation?.temperature,
    max_tokens: generation?.maxTokens,
    p: generation?.topP,
    k: generation?.topK,
    stop_sequences: generation?.stop,
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
// Every pending tool call finishes explicitly via its own `tool-call-end`
// event (unlike OpenAI Chat, which only signals completion via a top-level
// `finish_reason` and requires finishing every pending call at once).
const mapFinishReason = (reason: string | null | undefined): FinishReason => {
  if (reason === "COMPLETE" || reason === "STOP_SEQUENCE") return "stop"
  if (reason === "MAX_TOKENS") return "length"
  if (reason === "TOOL_CALL") return "tool-calls"
  if (reason === "ERROR") return "error"
  if (reason === "TIMEOUT") return "unknown"
  return "unknown"
}

const mapUsage = (usage: CohereUsage | undefined): Usage | undefined => {
  if (!usage) return undefined
  const inputTokens = usage.tokens?.input_tokens ?? usage.billed_units?.input_tokens
  const outputTokens = usage.tokens?.output_tokens ?? usage.billed_units?.output_tokens
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return new Usage({
    inputTokens,
    outputTokens,
    nonCachedInputTokens: inputTokens,
    totalTokens: ProviderShared.totalTokens(inputTokens, outputTokens, undefined),
    providerMetadata: { cohere: usage },
  })
}

const toolKey = (event: CohereEvent) => event.index ?? 0

type StepResult = readonly [ParserState, ReadonlyArray<LLMEvent>]

const NO_EVENTS: StepResult["1"] = []

const onContentDelta = (state: ParserState, event: CohereEvent): StepResult => {
  const content = event.delta?.message?.content
  const events: LLMEvent[] = []
  if (content?.thinking)
    return [{ ...state, lifecycle: Lifecycle.reasoningDelta(state.lifecycle, events, "reasoning-0", content.thinking) }, events]
  if (content?.text)
    return [{ ...state, lifecycle: Lifecycle.textDelta(state.lifecycle, events, "text-0", content.text) }, events]
  return [state, NO_EVENTS]
}

const onContentEnd = (state: ParserState): StepResult => {
  const events: LLMEvent[] = []
  const lifecycle = Lifecycle.reasoningEnd(Lifecycle.textEnd(state.lifecycle, events, "text-0"), events, "reasoning-0")
  return [{ ...state, lifecycle }, events]
}

const onToolPlanDelta = (state: ParserState, event: CohereEvent): StepResult => {
  const text = event.delta?.message?.tool_plan
  if (!text) return [state, NO_EVENTS]
  const events: LLMEvent[] = []
  return [{ ...state, lifecycle: Lifecycle.reasoningDelta(state.lifecycle, events, "reasoning-tool-plan", text) }, events]
}

const onToolCallStart = (state: ParserState, event: CohereEvent) =>
  Effect.gen(function* () {
    const call = event.delta?.message?.tool_calls
    if (!call?.id || !call.function?.name)
      return yield* ProviderShared.eventError(ADAPTER, "Cohere Chat tool-call-start is missing id or name")
    const events: LLMEvent[] = []
    const lifecycle = Lifecycle.stepStart(state.lifecycle, events)
    const tools = ToolStream.start(state.tools, toolKey(event), {
      id: call.id,
      name: call.function.name,
      input: call.function.arguments,
    })
    events.push(LLMEvent.toolInputStart({ id: call.id, name: call.function.name }))
    return [{ ...state, tools, lifecycle }, events] satisfies StepResult
  })

const onToolCallDelta = (state: ParserState, event: CohereEvent) =>
  Effect.gen(function* () {
    const text = event.delta?.message?.tool_calls?.function?.arguments
    if (!text) return [state, NO_EVENTS] satisfies StepResult
    const result = ToolStream.appendExisting(
      ADAPTER,
      state.tools,
      toolKey(event),
      text,
      "Cohere Chat tool-call-delta is missing its tool call",
    )
    if (ToolStream.isError(result)) return yield* result
    return [{ ...state, tools: result.tools }, result.events] satisfies StepResult
  })

const onToolCallEnd = (state: ParserState, event: CohereEvent) =>
  Effect.gen(function* () {
    const result = yield* ToolStream.finish(ADAPTER, state.tools, toolKey(event))
    const resultEvents = result.events ?? []
    const events: LLMEvent[] = []
    const lifecycle = resultEvents.length ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
    events.push(...resultEvents)
    return [{ ...state, tools: result.tools, lifecycle }, events] satisfies StepResult
  })

const onMessageEnd = (state: ParserState, event: CohereEvent): StepResult => {
  const usage = mapUsage(event.delta?.usage) ?? state.usage
  const events: LLMEvent[] = []
  const lifecycle = Lifecycle.finish(state.lifecycle, events, { reason: mapFinishReason(event.delta?.finish_reason), usage })
  return [{ ...state, usage, lifecycle }, events]
}

const step = (state: ParserState, event: CohereEvent) => {
  if (event.type === "content-delta") return Effect.succeed(onContentDelta(state, event))
  if (event.type === "content-end") return Effect.succeed(onContentEnd(state))
  if (event.type === "tool-plan-delta") return Effect.succeed(onToolPlanDelta(state, event))
  if (event.type === "tool-call-start") return onToolCallStart(state, event)
  if (event.type === "tool-call-delta") return onToolCallDelta(state, event)
  if (event.type === "tool-call-end") return onToolCallEnd(state, event)
  if (event.type === "message-end") return Effect.succeed(onMessageEnd(state, event))
  return Effect.succeed<StepResult>([state, NO_EVENTS])
}

// =============================================================================
// Protocol And Cohere Route
// =============================================================================
/**
 * The Cohere v2 Chat protocol — request body construction, body schema, and
 * the streaming-event state machine. Cohere's Chat API is not OpenAI-shaped
 * (see the request/stream schema comments above), so this is a dedicated
 * implementation rather than a reuse of `OpenAIChat.protocol`.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: CohereChatBody,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(CohereEvent),
    initial: () => ({ tools: ToolStream.empty<number>(), lifecycle: Lifecycle.initial() }),
    step,
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: "cohere",
  protocol,
  endpoint: Endpoint.path(PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  framing: Framing.sse,
})

export * as CohereChat from "./cohere-chat"

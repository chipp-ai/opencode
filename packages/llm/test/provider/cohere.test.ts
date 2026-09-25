import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMError, Message, ToolCallPart } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as Cohere from "../../src/providers/cohere"
import * as CohereChat from "../../src/protocols/cohere-chat"
import { it } from "../lib/effect"
import { dynamicResponse, fixedResponse } from "../lib/http"
import { sseEvents, sseRaw } from "../lib/sse"

const model = CohereChat.route
  .with({ endpoint: { baseURL: "https://api.cohere.test" }, auth: Auth.bearer("test-key") })
  .model({ id: "command-a-03-2025" })

const request = LLM.request({
  id: "req_1",
  model,
  system: "You are concise.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0 },
})

describe("Cohere Chat route", () => {
  it.effect("prepares a basic Cohere Chat target", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<CohereChat.CohereChatBody>(request)

      expect(prepared.body).toEqual({
        model: "command-a-03-2025",
        messages: [
          { role: "system", content: "You are concise." },
          { role: "user", content: "Say hello." },
        ],
        stream: true,
        max_tokens: 20,
        temperature: 0,
      })
    }),
  )

  it.effect("lowers tools and tool_choice: required", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<CohereChat.CohereChatBody>(
        LLM.request({
          model,
          prompt: "Use the tool.",
          tools: [
            {
              name: "lookup",
              description: "Lookup data",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
          toolChoice: { type: "required" },
        }),
      )

      expect(prepared.body.tools).toEqual([
        {
          type: "function",
          function: {
            name: "lookup",
            description: "Lookup data",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
        },
      ])
      expect(prepared.body.tool_choice).toBe("REQUIRED")
    }),
  )

  it.effect("maps tool_choice none to NONE and auto to omitted", () =>
    Effect.gen(function* () {
      const none = yield* LLMClient.prepare<CohereChat.CohereChatBody>(
        LLM.request({ model, prompt: "Hi", toolChoice: { type: "none" } }),
      )
      const auto = yield* LLMClient.prepare<CohereChat.CohereChatBody>(
        LLM.request({ model, prompt: "Hi", toolChoice: { type: "auto" } }),
      )

      expect(none.body.tool_choice).toBe("NONE")
      expect(auto.body.tool_choice).toBeUndefined()
    }),
  )

  it.effect("rejects forcing a single named tool", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.prepare(
        LLM.request({ model, prompt: "Hi", toolChoice: { type: "tool", name: "lookup" } }),
      ).pipe(Effect.flip)

      expect(error.message).toContain('does not support forcing a specific tool (requested "lookup")')
    }),
  )

  it.effect("round-trips assistant tool calls and tool results as Cohere document blocks", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<CohereChat.CohereChatBody>(
        LLM.request({
          model,
          messages: [
            Message.user("What's the weather?"),
            Message.assistant([
              { type: "reasoning", text: "I should look this up." },
              ToolCallPart.make({ id: "call_1", name: "lookup", input: { query: "weather" } }),
            ]),
            Message.tool({ id: "call_1", name: "lookup", result: { forecast: "sunny" } }),
          ],
        }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: undefined,
          tool_plan: "I should look this up.",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"weather"}' } }],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "document", document: { data: '{"forecast":"sunny"}' } }],
        },
      ])
    }),
  )

  it.effect("wraps chronological system updates as ordinary user text", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<CohereChat.CohereChatBody>(
        LLM.request({
          model,
          messages: [Message.user("Before."), Message.system("Update."), Message.assistant("After.")],
        }),
      )

      expect(prepared.body.messages).toEqual([
        { role: "user", content: "Before." },
        { role: "user", content: "<system-update>\nUpdate.\n</system-update>" },
        { role: "assistant", content: "After.", tool_plan: undefined, tool_calls: undefined },
      ])
    }),
  )

  it.effect("parses text, tool-plan, and usage stream fixtures", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        { type: "message-start", delta: { message: { role: "assistant" } } },
        { type: "tool-plan-delta", delta: { message: { tool_plan: "Thinking..." } } },
        { type: "content-start", index: 0, delta: { message: { content: { type: "text", text: "" } } } },
        { type: "content-delta", index: 0, delta: { message: { content: { text: "Hello" } } } },
        { type: "content-delta", index: 0, delta: { message: { content: { text: "!" } } } },
        { type: "content-end", index: 0 },
        {
          type: "message-end",
          delta: {
            finish_reason: "COMPLETE",
            usage: { billed_units: { input_tokens: 5, output_tokens: 2 }, tokens: { input_tokens: 6, output_tokens: 3 } },
          },
        },
      )
      const response = yield* LLMClient.generate(request).pipe(Effect.provide(fixedResponse(body)))

      expect(response.text).toBe("Hello!")
      expect(response.reasoning).toBe("Thinking...")
      expect(response.usage).toMatchObject({ inputTokens: 6, outputTokens: 3, nonCachedInputTokens: 6, totalTokens: 9 })
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
    }),
  )

  it.effect("streams parallel tool calls distinguished by index", () =>
    Effect.gen(function* () {
      const body = sseEvents(
        {
          type: "tool-call-start",
          index: 0,
          delta: { message: { tool_calls: { id: "call_0", function: { name: "lookup", arguments: "" } } } },
        },
        {
          type: "tool-call-start",
          index: 1,
          delta: { message: { tool_calls: { id: "call_1", function: { name: "lookup", arguments: "" } } } },
        },
        {
          type: "tool-call-delta",
          index: 0,
          delta: { message: { tool_calls: { function: { arguments: '{"query":"weather"}' } } } },
        },
        {
          type: "tool-call-delta",
          index: 1,
          delta: { message: { tool_calls: { function: { arguments: '{"query":"news"}' } } } },
        },
        { type: "tool-call-end", index: 0 },
        { type: "tool-call-end", index: 1 },
        { type: "message-end", delta: { finish_reason: "TOOL_CALL" } },
      )
      const response = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          tools: [{ name: "lookup", description: "Lookup data", inputSchema: { type: "object" } }],
        }),
      ).pipe(Effect.provide(fixedResponse(body)))

      expect(response.toolCalls).toEqual([
        { type: "tool-call", id: "call_0", name: "lookup", input: { query: "weather" } },
        { type: "tool-call", id: "call_1", name: "lookup", input: { query: "news" } },
      ])
      expect(response.events.at(-1)).toMatchObject({ type: "finish", reason: "tool-calls" })
    }),
  )

  it.effect("maps MAX_TOKENS and ERROR finish reasons", () =>
    Effect.gen(function* () {
      const length = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "message-end", delta: { finish_reason: "MAX_TOKENS" } }))),
      )
      const errored = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "message-end", delta: { finish_reason: "ERROR" } }))),
      )

      expect(length.events.at(-1)).toMatchObject({ type: "finish", reason: "length" })
      expect(errored.events.at(-1)).toMatchObject({ type: "finish", reason: "error" })
    }),
  )

  it.effect("fails invalid stream events", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse(sseRaw("data: {not json}"))),
        Effect.flip,
      )

      expect(error).toBeInstanceOf(LLMError)
      expect(error.message).toContain("Invalid cohere/cohere-chat stream event")
    }),
  )

  it.effect("posts to the configured endpoint with bearer auth", () =>
    Effect.gen(function* () {
      const response = yield* LLM.generate(
        LLM.request({ model: Cohere.configure({ apiKey: "co-secret" }).model("command-a-03-2025"), prompt: "Say hello." }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://api.cohere.com/v2/chat")
              expect(web.headers.get("authorization")).toBe("Bearer co-secret")
              return input.respond(
                sseEvents(
                  { type: "content-delta", index: 0, delta: { message: { content: { text: "Hello" } } } },
                  { type: "message-end", delta: { finish_reason: "COMPLETE" } },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Hello")
    }),
  )
})

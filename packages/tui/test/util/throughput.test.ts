import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { finalTokensPerSecond, liveTokensPerSecond, tokensPerSecond } from "../../src/util/throughput"

function message(input: { created: number; completed?: number; output?: number; reasoning?: number }) {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    parentID: "msg_0",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    time: { created: input.created, completed: input.completed },
    tokens: { input: 500, output: input.output ?? 0, reasoning: input.reasoning ?? 0, cache: { read: 900, write: 0 } },
  } satisfies AssistantMessage
}

function text(id: string, chars: number, time?: { start: number; end?: number }): Part {
  return { id, sessionID: "ses_1", messageID: "msg_1", type: "text", text: "x".repeat(chars), time }
}

function reasoning(id: string, chars: number, time: { start: number; end?: number }): Part {
  return { id, sessionID: "ses_1", messageID: "msg_1", type: "reasoning", text: "x".repeat(chars), time }
}

describe("tokensPerSecond", () => {
  test("divides tokens by elapsed seconds", () => {
    expect(tokensPerSecond(200, 1_000, 3_000)).toBe(100)
    expect(tokensPerSecond(125, 0, 1_500)).toBe(83)
  })

  test("returns undefined for windows under a second or no tokens", () => {
    expect(tokensPerSecond(200, 1_000, 1_999)).toBeUndefined()
    expect(tokensPerSecond(200, 1_000, 1_000)).toBeUndefined()
    expect(tokensPerSecond(200, 2_000, 1_000)).toBeUndefined()
    expect(tokensPerSecond(0, 0, 5_000)).toBeUndefined()
  })
})

describe("liveTokensPerSecond", () => {
  test("rate tracks a growing stream of timestamped deltas", () => {
    const msg = message({ created: 0 })
    // First token arrives at 2s (time-to-first-token), then 50 tok/s (200 chars/s) of output.
    const samples = [
      { now: 2_500, chars: 100 },
      { now: 3_000, chars: 200 },
      { now: 4_000, chars: 400 },
      { now: 6_000, chars: 800 },
    ]
    const rates = samples.map((sample) =>
      liveTokensPerSecond(msg, [text("a", sample.chars, { start: 2_000 })], sample.now),
    )
    expect(rates).toEqual([undefined, 50, 50, 50])
  })

  test("sums text and reasoning parts and measures from the earliest part start", () => {
    const parts = [reasoning("r", 400, { start: 1_000, end: 2_000 }), text("t", 400, { start: 2_000 })]
    // 800 chars = 200 tokens over 2s.
    expect(liveTokensPerSecond(message({ created: 0 }), parts, 3_000)).toBe(100)
  })

  test("excludes tool execution after the last generated part finished", () => {
    const parts = [
      text("t", 800, { start: 1_000, end: 3_000 }),
      {
        id: "tool",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "tool",
        callID: "c",
        tool: "bash",
        state: { status: "pending", input: {}, raw: "" },
      } satisfies Part,
    ]
    expect(liveTokensPerSecond(message({ created: 0 }), parts, 30_000)).toBe(100)
  })

  test("falls back to message creation when parts have no timestamps", () => {
    expect(liveTokensPerSecond(message({ created: 1_000 }), [text("t", 400)], 3_000)).toBe(50)
  })

  test("returns undefined before any output", () => {
    expect(liveTokensPerSecond(message({ created: 0 }), [], 5_000)).toBeUndefined()
  })
})

describe("finalTokensPerSecond", () => {
  test("uses reported output and reasoning tokens, ignoring input and cache", () => {
    const msg = message({ created: 0, completed: 5_000, output: 300, reasoning: 100 })
    expect(finalTokensPerSecond(msg, [text("t", 10, { start: 1_000, end: 5_000 })])).toBe(100)
  })

  test("returns undefined until the message completes", () => {
    expect(finalTokensPerSecond(message({ created: 0, output: 300 }), [])).toBeUndefined()
  })
})

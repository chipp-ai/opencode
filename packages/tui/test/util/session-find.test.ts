import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { errorTarget, findMatches, highlightSegments, partSearchText, stepIndex } from "../../src/util/session-find"

function textPart(id: string, messageID: string, text: string, synthetic = false) {
  return { id, messageID, sessionID: "ses", type: "text", text, synthetic } as Part
}

function reasoningPart(id: string, messageID: string, text: string) {
  return { id, messageID, sessionID: "ses", type: "reasoning", text, time: { start: 0 } } as Part
}

function toolPart(id: string, messageID: string, input: Record<string, unknown>, output = "") {
  return {
    id,
    messageID,
    sessionID: "ses",
    type: "tool",
    tool: "bash",
    callID: id,
    state: { status: "completed", input, output, title: "", metadata: {}, time: { start: 0, end: 0 } },
  } as Part
}

function user(id: string) {
  return { id, sessionID: "ses", role: "user", time: { created: 0 } } as Message
}

function assistant(id: string, error?: { name: string; data: { message: string } }) {
  return { id, sessionID: "ses", role: "assistant", time: { created: 0 }, error } as Message
}

function search(messages: Message[], parts: Part[], query: string) {
  return findMatches({
    messages,
    parts: (messageID) => parts.filter((part) => part.messageID === messageID),
    query,
  })
}

describe("partSearchText", () => {
  test("reads text and reasoning, skips synthetic text", () => {
    expect(partSearchText(textPart("p1", "m", "answer"))).toBe("answer")
    expect(partSearchText(textPart("p2", "m", "hidden", true))).toBe("")
    expect(partSearchText(reasoningPart("p3", "m", "thinking"))).toBe("thinking")
  })

  test("searches nested tool input values but not tool output", () => {
    const part = toolPart("p1", "m", { command: "echo findmarker", timeout: 30, args: ["--flag", { deep: "x" }] }, "out")
    expect(partSearchText(part)).toBe("echo findmarker\n--flag\nx")
  })
})

describe("findMatches", () => {
  test("matches case-insensitively in transcript order and targets rendered ids", () => {
    const messages = [user("u1"), assistant("a1"), user("u2")]
    const parts = [
      textPart("p1", "u1", "Deploy the App"),
      textPart("p2", "a1", "done"),
      reasoningPart("p3", "a1", "the app is ready"),
      textPart("p4", "u2", "another app mention"),
    ]
    expect(search(messages, parts, "APP")).toEqual([
      { messageID: "u1", target: "u1" },
      { messageID: "a1", target: "p3" },
      { messageID: "u2", target: "u2" },
    ])
  })

  test("collapses user text parts into one match on the message box", () => {
    const parts = [textPart("p1", "u1", "app one"), textPart("p2", "u1", "app two")]
    expect(search([user("u1")], parts, "app")).toEqual([{ messageID: "u1", target: "u1" }])
  })

  test("ignores synthetic user text", () => {
    expect(search([user("u1")], [textPart("p1", "u1", "secret", true)], "secret")).toEqual([])
  })

  test("matches assistant error rows but not aborts", () => {
    const failed = assistant("a1", { name: "APIError", data: { message: "rate limit boom" } })
    const aborted = assistant("a2", { name: "MessageAbortedError", data: { message: "boom" } })
    expect(search([failed, aborted], [], "boom")).toEqual([{ messageID: "a1", target: errorTarget("a1") }])
  })

  test("returns empty for blank or unmatched queries", () => {
    const parts = [textPart("p1", "u1", "hello")]
    expect(search([user("u1")], parts, "   ")).toEqual([])
    expect(search([user("u1")], parts, "zzz")).toEqual([])
  })
})

describe("highlightSegments", () => {
  test("splits matches case-insensitively and preserves original casing", () => {
    expect(highlightSegments("Find the find FIND", "find")).toEqual([
      { text: "Find", match: true },
      { text: " the ", match: false },
      { text: "find", match: true },
      { text: " ", match: false },
      { text: "FIND", match: true },
    ])
  })

  test("escapes regex characters in the query", () => {
    expect(highlightSegments("a.b axb", "a.b")).toEqual([
      { text: "a.b", match: true },
      { text: " axb", match: false },
    ])
  })

  test("returns the whole text for a blank query", () => {
    expect(highlightSegments("hello", " ")).toEqual([{ text: "hello", match: false }])
  })
})

describe("stepIndex", () => {
  test("wraps in both directions", () => {
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(2)
    expect(stepIndex(0, 0, 1)).toBe(0)
  })
})

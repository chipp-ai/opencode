import { describe, expect, test } from "bun:test"
import type { Message, SessionMessage } from "@opencode-ai/sdk/v2"
import { createTuiApiAdapters } from "../../src/plugin/adapters"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

type Input = Parameters<typeof createTuiApiAdapters>[0]

const model = { providerID: "anthropic", id: "claude" }
const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 5, write: 0 } }

// Newest-first, as the V2 bridge stores it.
const v2Messages: SessionMessage[] = [
  {
    id: "msg_a",
    type: "assistant",
    agent: "build",
    model,
    time: { created: 2, completed: 3 },
    finish: "stop",
    cost: 0.25,
    tokens,
    content: [{ type: "text", id: "t1", text: "hi" }],
  },
  { id: "msg_u", type: "user", text: "hello", time: { created: 1 } },
]

const legacy = [{ id: "msg_legacy", sessionID: "ses_1", role: "user" }] as unknown as Message[]

function state(input: { enabled: boolean; legacy?: Message[]; v2?: SessionMessage[] }) {
  const sync = {
    data: {
      capabilities: { experimentalV2Session: input.enabled },
      message: input.legacy ? { ses_1: input.legacy } : {},
    },
    session: { get: () => ({ directory: "/repo" }) },
  }
  const data = {
    session: {
      get: () => ({ agent: "build", model }),
      message: { list: () => input.v2 },
    },
  }
  return createTuiApiAdapters({
    tuiConfig: createTuiResolvedConfig(),
    dialog: { stack: [] },
    sync,
    data,
  } as unknown as Input).state
}

describe("state.session.messages", () => {
  test("projects a V2 session's transcript into V1 messages", () => {
    const messages = state({ enabled: true, v2: v2Messages }).session.messages("ses_1")
    expect(messages.map((message) => [message.id, message.role])).toEqual([
      ["msg_u", "user"],
      ["msg_a", "assistant"],
    ])
    const assistant = messages[1]
    if (assistant?.role !== "assistant") throw new Error("expected assistant")
    expect(assistant.tokens).toEqual(tokens)
    expect(assistant.cost).toBe(0.25)
    expect([assistant.providerID, assistant.modelID]).toEqual(["anthropic", "claude"])
    expect(assistant.path.cwd).toBe("/repo")
  })

  test("is empty for a V2 session whose transcript has not loaded", () => {
    expect(state({ enabled: true }).session.messages("ses_1")).toEqual([])
  })

  test("keeps sessions with legacy history on the legacy store", () => {
    expect(state({ enabled: true, legacy, v2: v2Messages }).session.messages("ses_1")).toBe(legacy)
  })

  test("uses the legacy store when V2 is disabled", () => {
    expect(state({ enabled: false, v2: v2Messages }).session.messages("ses_1")).toEqual([])
  })
})

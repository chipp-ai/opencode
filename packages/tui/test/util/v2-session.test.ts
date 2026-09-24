import { describe, expect, test } from "bun:test"
import type { Provider, SessionMessage } from "@opencode-ai/sdk/v2"
import {
  isV2Session,
  isV2SessionBusy,
  liveSwitch,
  switchLabel,
  toV1Permission,
  toV1Question,
  toV1Transcript,
  toV2Prompt,
  V2_UNAVAILABLE_COMMANDS,
  v2SwitchPlan,
  type V2Switch,
} from "../../src/util/v2-session"

const model = { providerID: "anthropic", id: "claude" }

describe("isV2Session", () => {
  test("stays on V1 when the flag is off", () => {
    expect(isV2Session({ enabled: false, legacyMessageCount: 0 })).toBe(false)
  })

  test("keeps sessions with legacy history on V1 even when the flag is on", () => {
    expect(isV2Session({ enabled: true, legacyMessageCount: 3 })).toBe(false)
  })

  test("uses V2 for sessions without legacy history when the flag is on", () => {
    expect(isV2Session({ enabled: true, legacyMessageCount: 0 })).toBe(true)
  })
})

describe("V2_UNAVAILABLE_COMMANDS", () => {
  test("covers the V1-only session commands", () => {
    for (const command of ["session.share", "session.unshare", "session.fork", "session.compact"])
      expect(V2_UNAVAILABLE_COMMANDS.has(command)).toBe(true)
    expect(V2_UNAVAILABLE_COMMANDS.has("session.rename")).toBe(false)
  })
})

describe("v2SwitchPlan", () => {
  test("switches nothing when the session already matches", () => {
    expect(v2SwitchPlan({ agent: "build", model }, { agent: "build", model })).toEqual({
      agent: undefined,
      model: undefined,
    })
  })

  test("switches only what changed", () => {
    expect(v2SwitchPlan({ agent: "build", model }, { agent: "plan", model })).toEqual({
      agent: "plan",
      model: undefined,
    })
    const next = { providerID: "openai", id: "gpt" }
    expect(v2SwitchPlan({ agent: "build", model }, { agent: "build", model: next })).toEqual({
      agent: undefined,
      model: next,
    })
  })

  test("treats an omitted variant as default, like the server", () => {
    expect(
      v2SwitchPlan({ agent: "build", model: { ...model, variant: "default" } }, { agent: "build", model }).model,
    ).toBeUndefined()
    expect(v2SwitchPlan({ agent: "build", model }, { agent: "build", model: { ...model, variant: "high" } }).model).toEqual(
      { ...model, variant: "high" },
    )
  })

  test("switches both when the session has no selection yet", () => {
    expect(v2SwitchPlan({}, { agent: "build", model })).toEqual({ agent: "build", model })
  })
})

describe("isV2SessionBusy", () => {
  const user: SessionMessage = { id: "msg_u", type: "user", text: "hi", time: { created: 1 } }
  const assistant = (completed?: number): SessionMessage => ({
    id: "msg_a",
    type: "assistant",
    agent: "build",
    model,
    content: [],
    time: { created: 2, completed },
  })

  test("is idle with no transcript", () => {
    expect(isV2SessionBusy()).toBe(false)
    expect(isV2SessionBusy([])).toBe(false)
  })

  test("is busy while a promoted prompt awaits its first step", () => {
    expect(isV2SessionBusy([user])).toBe(true)
  })

  test("is busy while the newest step is unfinished and idle once it completes", () => {
    expect(isV2SessionBusy([assistant(), user])).toBe(true)
    expect(isV2SessionBusy([assistant(3), user])).toBe(false)
  })

  test("ignores non-turn messages such as model switches", () => {
    const switched: SessionMessage = { id: "msg_s", type: "model-switched", model, time: { created: 4 } }
    expect(isV2SessionBusy([switched, assistant(3), user])).toBe(false)
  })
})

describe("toV2Prompt", () => {
  test("maps file and agent parts to V2 attachments", () => {
    expect(
      toV2Prompt("look at @a.ts with @explore", [
        {
          type: "file",
          mime: "text/plain",
          filename: "a.ts",
          url: "file:///repo/a.ts",
          source: { type: "file", path: "a.ts", text: { start: 8, end: 13, value: "@a.ts" } },
        },
        { type: "agent", name: "explore", source: { start: 19, end: 27, value: "@explore" } },
        { type: "text", text: "pasted" },
      ]),
    ).toEqual({
      text: "look at @a.ts with @explore",
      files: [{ uri: "file:///repo/a.ts", name: "a.ts", source: { start: 8, end: 13, text: "@a.ts" } }],
      agents: [{ name: "explore", source: { start: 19, end: 27, text: "@explore" } }],
    })
  })

  test("omits empty attachment lists", () => {
    expect(toV2Prompt("hello", [])).toEqual({ text: "hello", files: undefined, agents: undefined })
  })
})

describe("toV1Permission", () => {
  test("maps a V2 permission request onto the legacy prompt shape", () => {
    expect(
      toV1Permission({
        id: "per_1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["ls -la"],
        save: ["ls *"],
        source: { type: "tool", messageID: "msg_1", callID: "call_1" },
      }),
    ).toEqual({
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["ls -la"],
      metadata: {},
      always: ["ls *"],
      tool: { messageID: "msg_1", callID: "call_1" },
    })
  })
})

describe("toV1Question", () => {
  test("keeps the question payload", () => {
    const questions = [{ question: "Pick", header: "Pick", options: [{ label: "A", description: "a" }] }]
    expect(toV1Question({ id: "que_1", sessionID: "ses_1", questions })).toEqual({
      id: "que_1",
      sessionID: "ses_1",
      questions,
      tool: undefined,
    })
  })
})

describe("toV1Transcript", () => {
  // Newest-first, as delivered by the V2 bridge and the messages endpoint.
  const messages: SessionMessage[] = [
    {
      id: "msg_a",
      type: "assistant",
      agent: "build",
      model,
      time: { created: 3, completed: 9 },
      finish: "stop",
      cost: 0.5,
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [
        { type: "reasoning", id: "r1", text: "thinking" },
        {
          type: "tool",
          id: "call_1",
          name: "bash",
          time: { created: 4, ran: 5, completed: 6 },
          state: {
            status: "completed",
            input: { command: "ls" },
            structured: { exit: 0, truncated: false },
            content: [{ type: "text", text: "file.txt" }],
          },
        },
        {
          type: "tool",
          id: "call_2",
          name: "edit",
          time: { created: 6, ran: 7, completed: 8 },
          state: {
            status: "completed",
            input: { path: "/repo/a.ts", oldString: "a", newString: "b" },
            structured: { files: [{ file: "a.ts", patch: "--- a\n+++ b", additions: 1, deletions: 1 }] },
            content: [{ type: "text", text: "Edited" }],
          },
        },
        { type: "text", id: "t1", text: "done" },
      ],
    },
    { id: "msg_s", type: "system", text: "context", time: { created: 2 } },
    {
      id: "msg_u",
      type: "user",
      text: "list files",
      files: [{ uri: "file:///repo/a.ts", mime: "text/plain", name: "a.ts" }],
      time: { created: 1 },
    },
  ]
  const transcript = toV1Transcript({
    sessionID: "ses_1",
    directory: "/repo",
    messages,
    agent: "build",
    model,
  })

  test("orders messages oldest-first and drops messages with no V1 representation", () => {
    expect(transcript.messages.map((message) => [message.id, message.role])).toEqual([
      ["msg_u", "user"],
      ["msg_a", "assistant"],
    ])
  })

  test("builds user text and file parts with the seeded selection", () => {
    const user = transcript.messages[0]
    expect(user.role === "user" && user.agent).toBe("build")
    expect(user.role === "user" && user.model).toEqual({ providerID: "anthropic", modelID: "claude", variant: undefined })
    expect(transcript.parts.msg_u.map((part) => part.type)).toEqual(["text", "file"])
  })

  test("links the assistant to its prompt and keeps usage", () => {
    const assistant = transcript.messages[1]
    if (assistant.role !== "assistant") throw new Error("expected assistant")
    expect(assistant.parentID).toBe("msg_u")
    expect(assistant.providerID).toBe("anthropic")
    expect(assistant.modelID).toBe("claude")
    expect(assistant.finish).toBe("stop")
    expect(assistant.cost).toBe(0.5)
    expect(assistant.path.cwd).toBe("/repo")
  })

  test("maps tool results onto the metadata keys the shared renderers read", () => {
    const parts = transcript.parts.msg_a
    expect(parts.map((part) => part.type)).toEqual(["reasoning", "tool", "tool", "text"])
    const bash = parts[1]
    if (bash.type !== "tool" || bash.state.status !== "completed") throw new Error("expected completed tool")
    expect(bash.tool).toBe("bash")
    expect(bash.callID).toBe("call_1")
    expect(bash.state.output).toBe("file.txt")
    expect(bash.state.metadata.output).toBe("file.txt")
    expect(bash.state.time).toEqual({ start: 5, end: 6 })
    const edit = parts[2]
    if (edit.type !== "tool" || edit.state.status !== "completed") throw new Error("expected completed tool")
    expect(edit.state.input.filePath).toBe("/repo/a.ts")
    expect(edit.state.metadata.diff).toBe("--- a\n+++ b")
  })

  test("marks reasoning finished once later content arrives", () => {
    const reasoning = transcript.parts.msg_a[0]
    if (reasoning.type !== "reasoning") throw new Error("expected reasoning")
    expect(reasoning.time.end).toBeDefined()
  })

  test("keeps in-flight tools and reasoning open", () => {
    const live = toV1Transcript({
      sessionID: "ses_1",
      directory: "/repo",
      messages: [
        {
          id: "msg_b",
          type: "assistant",
          agent: "build",
          model,
          time: { created: 1 },
          content: [
            {
              type: "tool",
              id: "call_3",
              name: "bash",
              time: { created: 1 },
              state: { status: "pending", input: '{"comm' },
            },
            { type: "reasoning", id: "r2", text: "still thinking" },
          ],
        },
      ],
    })
    const [tool, reasoning] = live.parts.msg_b
    expect(tool.type === "tool" && tool.state).toEqual({ status: "pending", input: {}, raw: '{"comm' })
    expect(reasoning.type === "reasoning" && reasoning.time.end).toBeUndefined()
  })

  test("carries agent and model switches forward to later user messages", () => {
    const switched = toV1Transcript({
      sessionID: "ses_1",
      directory: "/repo",
      messages: [
        { id: "msg_2", type: "user", text: "again", time: { created: 3 } },
        { id: "msg_m", type: "model-switched", model: { providerID: "openai", id: "gpt" }, time: { created: 2 } },
        { id: "msg_g", type: "agent-switched", agent: "plan", time: { created: 1 } },
      ],
    })
    const user = switched.messages[0]
    expect(user.role === "user" && user.agent).toBe("plan")
    expect(user.role === "user" && user.model.providerID).toBe("openai")
  })

  test("surfaces a failed step as an assistant error", () => {
    const failed = toV1Transcript({
      sessionID: "ses_1",
      directory: "/repo",
      messages: [
        {
          id: "msg_f",
          type: "assistant",
          agent: "build",
          model,
          time: { created: 1, completed: 2 },
          finish: "error",
          error: { type: "unknown", message: "boom" },
          content: [],
        },
      ],
    })
    const assistant = failed.messages[0]
    expect(assistant.role === "assistant" && assistant.error).toEqual({ name: "UnknownError", data: { message: "boom" } })
  })
})

describe("toV1Transcript switches", () => {
  const primary = { providerID: "fake", id: "primary" }
  const backup = { providerID: "fake", id: "backup" }
  // Newest-first: a switch before any prompt, a prompt, then switches and a continuation on the fallback model.
  const transcript = toV1Transcript({
    sessionID: "ses_1",
    directory: "/repo",
    agent: "build",
    model: primary,
    messages: [
      {
        id: "msg_a2",
        type: "assistant",
        agent: "build",
        model: backup,
        time: { created: 5, completed: 6 },
        content: [{ type: "text", id: "t", text: "ok" }],
      },
      { id: "msg_m", type: "model-switched", model: backup, time: { created: 4 } },
      { id: "msg_g", type: "agent-switched", agent: "plan", time: { created: 3 } },
      { id: "msg_u", type: "user", text: "hi", time: { created: 2 } },
      { id: "msg_m0", type: "model-switched", model: primary, time: { created: 1 } },
    ],
  })

  test("anchors each switch after the entry it follows, oldest first", () => {
    const ids = Object.fromEntries(
      Object.entries(transcript.switches).map(([key, list]) => [key, list.map((item) => item.id)]),
    )
    expect(ids).toEqual({ "": ["msg_m0"], msg_u: ["msg_g", "msg_m"] })
  })

  test("keeps switches out of the V1 message list", () => {
    expect(transcript.messages.map((message) => message.id)).toEqual(["msg_u", "msg_a2"])
  })
})

describe("switchLabel", () => {
  const providers: Provider[] = [
    {
      id: "fake",
      name: "Fake",
      source: "config",
      env: [],
      options: {},
      models: {
        backup: {
          id: "backup",
          providerID: "fake",
          api: { id: "backup", url: "http://localhost", npm: "@ai-sdk/openai-compatible" },
          name: "Backup",
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 1000, output: 100 },
          status: "active",
          options: {},
          headers: {},
          release_date: "2026-01-01",
        },
      },
    },
  ]

  test("names the model with its catalog display name", () => {
    const item: V2Switch = {
      id: "m",
      type: "model-switched",
      model: { providerID: "fake", id: "backup" },
      time: { created: 1 },
    }
    expect(switchLabel(item, providers)).toBe("Switched to Backup")
  })

  test("falls back to the raw model id when the catalog does not know it", () => {
    const item: V2Switch = {
      id: "m",
      type: "model-switched",
      model: { providerID: "gone", id: "old-model" },
      time: { created: 1 },
    }
    expect(switchLabel(item, providers)).toBe("Switched to old-model")
  })

  test("titlecases agent names", () => {
    const item: V2Switch = { id: "g", type: "agent-switched", agent: "plan", time: { created: 1 } }
    expect(switchLabel(item, providers)).toBe("Switched to Plan agent")
  })
})

describe("liveSwitch", () => {
  const openedAt = 1_000

  test("ignores switches already in history when V2 history first loads", () => {
    expect(liveSwitch(undefined, { sessionID: "ses_1", id: "msg_m", created: 500 }, openedAt)).toBe(false)
  })

  test("ignores past switches seen while navigating to another session", () => {
    expect(
      liveSwitch({ sessionID: "ses_1", id: "msg_a" }, { sessionID: "ses_2", id: "msg_b", created: 500 }, openedAt),
    ).toBe(false)
  })

  test("counts a switch made after opening even when it lands before history finishes loading", () => {
    // A new Session's first turn can fail over before the TUI marks it as loaded.
    expect(liveSwitch(undefined, { sessionID: "ses_1", id: "msg_m", created: 1_200 }, openedAt)).toBe(true)
  })

  test("ignores transcript updates that leave the newest switch unchanged", () => {
    expect(liveSwitch({ sessionID: "ses_1", id: "msg_m" }, { sessionID: "ses_1", id: "msg_m" }, openedAt)).toBe(false)
    expect(liveSwitch({ sessionID: "ses_1" }, { sessionID: "ses_1" }, openedAt)).toBe(false)
  })

  test("detects a new switch in the loaded session, including its first one", () => {
    expect(liveSwitch({ sessionID: "ses_1", id: "msg_m" }, { sessionID: "ses_1", id: "msg_n" }, openedAt)).toBe(true)
    expect(liveSwitch({ sessionID: "ses_1" }, { sessionID: "ses_1", id: "msg_m" }, openedAt)).toBe(true)
  })
})

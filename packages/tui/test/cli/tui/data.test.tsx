/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { onMount, type ParentProps } from "solid-js"
import { ArgsProvider } from "../../../src/context/args"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { DataProvider, useData } from "../../../src/context/data"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"

function TestData(props: ParentProps<{ auto?: boolean }>) {
  return (
    <ArgsProvider auto={props.auto}>
      <PermissionProvider>
        <DataProvider>{props.children}</DataProvider>
      </PermissionProvider>
    </ArgsProvider>
  )
}

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function global(payload: Event): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

function emitEvent(events: ReturnType<typeof createEventSource>, payload: Event) {
  events.emit(global(payload))
}

test("refreshes resources into reactive getters", async () => {
  const events = createEventSource()
  const location = {
    directory,
    project: { id: "proj_test", directory },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_test")
      return json({
        data: {
          id: "ses_test",
          projectID: "proj_test",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
          title: "Test session",
          location: { directory },
        },
      })
    if (url.pathname === "/api/agent")
      return json({
        location,
        data: [{ id: "build", request: { headers: {}, body: {} }, mode: "primary", hidden: false, permissions: [] }],
      })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    expect(data.location.default()).toEqual({ directory })
    expect(data.session.get("ses_test")).toBeUndefined()
    expect(data.location.agent.list(location)).toBeUndefined()

    await data.session.refresh("ses_test")
    await data.location.agent.refresh()

    expect(data.session.get("ses_test")?.title).toBe("Test session")
    expect(data.location.default()).toEqual({ directory, workspaceID: undefined })
    expect(data.location.agent.list(location)?.map((agent) => agent.id)).toEqual(["build"])
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes integrations after integration updates", async () => {
  const events = createEventSource()
  const requests = { integration: 0, model: 0, provider: 0 }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/model") {
      requests.model++
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: [] })
    }
    if (url.pathname === "/api/provider") {
      requests.provider++
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: [] })
    }
    if (url.pathname !== "/api/integration") return
    requests.integration++
    return json({
      location: { directory, project: { id: "proj_test", directory } },
      data:
        requests.integration === 1
          ? []
          : [
              {
                id: "openai",
                name: "OpenAI",
                methods: [{ type: "key" }],
              },
            ],
    })
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await wait(() => data.location.integration.list() !== undefined)
    expect(data.location.integration.list()).toEqual([])
    const before = { ...requests }

    emitEvent(events, { id: "evt_integration", type: "integration.updated", properties: {} })
    await wait(() => data.location.integration.list()?.length === 1)
    await wait(() => requests.model > before.model && requests.provider > before.provider)
    expect(data.location.integration.list()?.[0]).toMatchObject({ id: "openai", name: "OpenAI" })
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes effective catalog data after catalog updates", async () => {
  const events = createEventSource()
  const requests = { model: 0, provider: 0 }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/model") {
      requests.model++
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: [] })
    }
    if (url.pathname === "/api/provider") {
      requests.provider++
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: [] })
    }
  }, events)

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <box />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => requests.model > 0 && requests.provider > 0)
    const before = { ...requests }
    emitEvent(events, { id: "evt_catalog", type: "catalog.updated", properties: {} })
    await wait(() => requests.model > before.model && requests.provider > before.provider)
  } finally {
    app.renderer.destroy()
  }
})

test("refreshes references after updates", async () => {
  const events = createEventSource()
  let requests = 0
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/reference") return
    requests++
    return json({
      location: { directory, project: { id: "proj_test", directory } },
      data: requests === 1 ? [] : [{ name: "docs", path: "/docs", source: { type: "local", path: "/docs" } }],
    })
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await wait(() => requests === 1)
    emitEvent(events, { id: "evt_reference_1", type: "reference.updated", properties: {} })
    await wait(() => data.location.reference.list()?.length === 1)
    expect(data.location.reference.list()?.[0]?.name).toBe("docs")
  } finally {
    app.renderer.destroy()
  }
})

test("settles pending tools when a live failure arrives", async () => {
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt_agent_1",
      type: "session.next.agent.switched",
      properties: { sessionID: "session-1", messageID: "msg_agent_1", timestamp: 0, agent: "build" },
    })
    emitEvent(events, {
      id: "evt_model_1",
      type: "session.next.model.switched",
      properties: {
        sessionID: "session-1",
        messageID: "msg_model_1",
        timestamp: 0,
        model: { id: "model-1", providerID: "provider-1" },
      },
    })
    emitEvent(events, {
      id: "evt_step_started_1",
      type: "session.next.step.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_explicit_assistant_9",
        timestamp: 1,
        agent: "build",
        model: { id: "model-1", providerID: "provider-1" },
      },
    })
    emitEvent(events, {
      id: "evt_input_1",
      type: "session.next.tool.input.started",
      properties: {
        sessionID: "session-1",
        assistantMessageID: "msg_explicit_assistant_9",
        timestamp: 2,
        callID: "call-1",
        name: "bash",
      },
    })
    emitEvent(events, {
      id: "evt_called_1",
      type: "session.next.tool.called",
      properties: {
        sessionID: "session-1",
        timestamp: 2,
        assistantMessageID: "msg_explicit_assistant_9",
        callID: "call-1",
        tool: "bash",
        input: {},
        provider: { executed: false, metadata: { fake: { call: true } } },
      },
    })
    emitEvent(events, {
      id: "evt_failed_1",
      type: "session.next.tool.failed",
      properties: {
        sessionID: "session-1",
        timestamp: 3,
        assistantMessageID: "msg_explicit_assistant_9",
        callID: "call-1",
        error: { type: "unknown", message: "aborted" },
        provider: { executed: false, metadata: { fake: { result: true } } },
      },
    })

    await wait(() => {
      const assistant = sync.session.message.list("session-1")?.[0]
      return (
        assistant?.type === "assistant" &&
        assistant.content[0]?.type === "tool" &&
        assistant.content[0].state.status === "error"
      )
    })

    const assistant = sync.session.message.list("session-1")?.[0]
    expect(assistant?.type).toBe("assistant")
    if (assistant?.type !== "assistant") return
    expect(assistant.id).toBe("msg_explicit_assistant_9")
    const tool = assistant.content[0]
    expect(tool?.type).toBe("tool")
    if (tool?.type !== "tool") return
    expect(tool.state.status).toBe("error")
    if (tool.state.status !== "error") return
    expect(tool.state.error).toEqual({ type: "unknown", message: "aborted" })
    expect(tool.state.input).toEqual({})
    expect(tool.state.structured).toEqual({})
    expect(tool.state.content).toEqual([])
    expect(tool.provider).toEqual({
      executed: false,
      metadata: { fake: { call: true } },
      resultMetadata: { fake: { result: true } },
    })
    expect((sync.session.message.list("session-1") ?? []).map((message) => message.type)).toEqual([
      "assistant",
      "model-switched",
      "agent-switched",
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("renders admitted prompts only after they become model-visible", async () => {
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt_admitted_1",
      type: "session.next.prompt.admitted",
      properties: {
        sessionID: "session-1",
        messageID: "msg_user_1",
        timestamp: 0,
        prompt: { text: "hello" },
        delivery: "steer",
      },
    })
    expect(sync.session.message.list("session-1") ?? []).toEqual([])

    emitEvent(events, {
      id: "evt_prompted_1",
      type: "session.next.prompted",
      properties: {
        sessionID: "session-1",
        messageID: "msg_user_1",
        timestamp: 0,
        prompt: { text: "hello" },
        delivery: "steer",
      },
    })

    await wait(() => sync.session.message.list("session-1")?.length === 1)
    const message = sync.session.message.list("session-1")?.[0]
    expect(message?.type).toBe("user")
    if (message?.type !== "user") return
    expect(message).toMatchObject({ id: "msg_user_1", text: "hello" })
  } finally {
    app.renderer.destroy()
  }
})

test("projects live context updates with their message ID", async () => {
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    emitEvent(events, {
      id: "evt_context_1",
      type: "session.next.context.updated",
      properties: {
        sessionID: "session-1",
        messageID: "msg_context_1",
        timestamp: 1,
        text: "Updated context",
      },
    })

    await wait(() => sync.session.message.list("session-1")?.length === 1)
    expect(sync.session.message.list("session-1")?.[0]).toMatchObject({
      id: "msg_context_1",
      type: "system",
      text: "Updated context",
    })
  } finally {
    app.renderer.destroy()
  }
})

test("tracks pending inputs from admission until promotion, withdrawal, or revision", async () => {
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  const admit = (messageID: string, text: string) =>
    emitEvent(events, {
      id: `evt_admitted_${messageID}`,
      type: "session.next.prompt.admitted",
      properties: { sessionID: "session-1", messageID, timestamp: 0, prompt: { text }, delivery: "queue" },
    })
  const pending = () => (sync.session.input.list("session-1") ?? []).map((input) => [input.id, input.prompt.text])

  try {
    await mounted
    admit("msg_a", "first")
    admit("msg_b", "secnod")
    admit("msg_c", "third")
    await wait(() => pending().length === 3)
    expect(pending()).toEqual([
      ["msg_a", "first"],
      ["msg_b", "secnod"],
      ["msg_c", "third"],
    ])

    emitEvent(events, {
      id: "evt_revised_b",
      type: "session.next.prompt.revised",
      properties: { sessionID: "session-1", messageID: "msg_b", timestamp: 1, prompt: { text: "second" } },
    })
    emitEvent(events, {
      id: "evt_withdrawn_c",
      type: "session.next.prompt.withdrawn",
      properties: { sessionID: "session-1", messageID: "msg_c", timestamp: 1 },
    })
    emitEvent(events, {
      id: "evt_prompted_a",
      type: "session.next.prompted",
      properties: {
        sessionID: "session-1",
        messageID: "msg_a",
        timestamp: 2,
        prompt: { text: "first" },
        delivery: "queue",
      },
    })

    await wait(() => sync.session.message.list("session-1")?.length === 1)
    expect(pending()).toEqual([["msg_b", "second"]])
    expect(sync.session.message.list("session-1")?.[0]).toMatchObject({ id: "msg_a", text: "first" })
  } finally {
    app.renderer.destroy()
  }
})

test("withdraws and revises pending inputs through the v2 input routes", async () => {
  const events = createEventSource()
  const requests: { method: string; path: string; body?: unknown }[] = []
  const admitted = (id: string, text: string) => ({
    admittedSeq: 1,
    id,
    sessionID: "session-1",
    prompt: { text },
    delivery: "queue",
    timeCreated: 0,
  })
  const base = createFetch((url) => {
    if (url.pathname === "/api/session/session-1/input")
      return json({ data: [admitted("msg_a", "tpyo"), admitted("msg_b", "remove me")] })
    return undefined
  }, events)
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.pathname.startsWith("/api/session/session-1/input/")) {
      const body = request.method === "PATCH" ? await request.json() : undefined
      requests.push({ method: request.method, path: url.pathname, body })
      if (url.pathname.endsWith("/msg_gone"))
        return json({ _tag: "ConflictError", message: "no longer pending" }, { status: 409 })
      if (request.method === "DELETE") return new Response(null, { status: 204 })
      return json({ data: { ...admitted("msg_a", "typo") } })
    }
    return base.fetch(input, init)
  }) as typeof globalThis.fetch
  let sync!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await sync.session.input.refresh("session-1")
    await sync.session.input.revise("session-1", "msg_a", { text: "typo" })
    await sync.session.input.withdraw("session-1", "msg_b")

    expect(requests).toEqual([
      { method: "PATCH", path: "/api/session/session-1/input/msg_a", body: { prompt: { text: "typo" } } },
      { method: "DELETE", path: "/api/session/session-1/input/msg_b", body: undefined },
    ])
    expect((sync.session.input.list("session-1") ?? []).map((input) => [input.id, input.prompt.text])).toEqual([
      ["msg_a", "typo"],
    ])

    // A promotion that wins the race surfaces as a conflict and leaves local state untouched.
    await expect(sync.session.input.withdraw("session-1", "msg_gone")).rejects.toBeDefined()
    expect(sync.session.input.list("session-1")).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("tracks V2 permission and question requests and switch-driven session selection", async () => {
  const events = createEventSource()
  const session = {
    id: "ses_parent",
    projectID: "proj_test",
    agent: "build",
    model: { providerID: "anthropic", id: "claude" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    title: "Parent",
    location: { directory },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_parent") return json({ data: session })
    if (url.pathname === "/api/session/ses_child")
      return json({ data: { ...session, id: "ses_child", parentID: "ses_parent" } })
    return undefined
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await data.session.refresh("ses_parent")

    emitEvent(events, {
      id: "evt_agent",
      type: "session.next.agent.switched",
      properties: { sessionID: "ses_parent", messageID: "msg_agent", timestamp: 1, agent: "plan" },
    } as Event)
    emitEvent(events, {
      id: "evt_model",
      type: "session.next.model.switched",
      properties: {
        sessionID: "ses_parent",
        messageID: "msg_model",
        timestamp: 2,
        model: { providerID: "openai", id: "gpt" },
      },
    } as Event)
    await wait(
      () => data.session.get("ses_parent")?.agent === "plan" && data.session.get("ses_parent")?.model?.id === "gpt",
    )
    expect(data.session.get("ses_parent")?.model).toEqual({ providerID: "openai", id: "gpt" })

    // A subagent's request is attributed to its parent once the child session's info loads.
    emitEvent(events, {
      id: "evt_perm",
      type: "permission.v2.asked",
      properties: { id: "per_1", sessionID: "ses_child", action: "bash", resources: ["ls"] },
    } as Event)
    emitEvent(events, {
      id: "evt_question",
      type: "question.v2.asked",
      properties: { id: "que_1", sessionID: "ses_parent", questions: [{ question: "Q", header: "Q", options: [] }] },
    } as Event)
    await wait(() => data.session.permission.tree("ses_parent").length === 1)
    expect(data.session.permission.list("ses_child")?.map((request) => request.id)).toEqual(["per_1"])
    expect(data.session.question.tree("ses_parent").map((request) => request.id)).toEqual(["que_1"])

    emitEvent(events, {
      id: "evt_perm_reply",
      type: "permission.v2.replied",
      properties: { sessionID: "ses_child", requestID: "per_1", reply: "once" },
    } as Event)
    emitEvent(events, {
      id: "evt_question_reject",
      type: "question.v2.rejected",
      properties: { sessionID: "ses_parent", requestID: "que_1" },
    } as Event)
    await wait(() => data.session.permission.tree("ses_parent").length === 0)
    expect(data.session.question.tree("ses_parent")).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("auto-approves V2 permission requests for any session under --auto", async () => {
  const events = createEventSource()
  const replies: string[] = []
  const calls = createFetch((url) => {
    if (!url.pathname.endsWith("/reply")) return undefined
    replies.push(url.pathname)
    return new Response(null, { status: 204 })
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData auto>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    // No session route is mounted, so approval cannot depend on which session is open.
    for (const [id, sessionID] of [
      ["per_1", "ses_a"],
      ["per_2", "ses_b"],
    ])
      emitEvent(events, {
        id: `evt_${id}`,
        type: "permission.v2.asked",
        properties: { id, sessionID, action: "bash", resources: ["ls"] },
      } as Event)
    await wait(() => replies.length === 2)
    expect(replies.toSorted()).toEqual([
      "/api/session/ses_a/permission/per_1/reply",
      "/api/session/ses_b/permission/per_2/reply",
    ])
    // Approved requests never become pending prompts.
    expect(data.session.permission.list("ses_a")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("pages older V2 messages until a short page ends the history", async () => {
  const events = createEventSource()
  // 250 messages, newest first; the endpoint pages 200 at a time.
  const all = Array.from({ length: 250 }, (_, index) => ({
    id: `msg_${String(250 - index).padStart(3, "0")}`,
    type: "user" as const,
    text: `m${250 - index}`,
    time: { created: 250 - index },
  }))
  const cursors: (string | null)[] = []
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/session/ses_page/message") return undefined
    const cursor = url.searchParams.get("cursor")
    cursors.push(cursor)
    const page = cursor === "c1" ? all.slice(200) : all.slice(0, 200)
    return json({ data: page, cursor: { next: cursor === "c1" ? "c2" : "c1" } })
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await data.session.message.refresh("ses_page")
    expect(data.session.message.list("ses_page")?.length).toBe(200)
    expect(data.session.message.hasOlder("ses_page")).toBe(true)

    await data.session.message.loadOlder("ses_page")
    const ids = data.session.message.list("ses_page")?.map((message) => message.id) ?? []
    expect(ids).toEqual(all.map((message) => message.id))
    // The short second page is the end of history, so no further request is made.
    expect(data.session.message.hasOlder("ses_page")).toBe(false)
    await data.session.message.loadOlder("ses_page")
    expect(cursors).toEqual([null, "c1"])
  } finally {
    app.renderer.destroy()
  }
})

test("tracks pushed V2 session status and seeds it only for sessions without a pushed value", async () => {
  const events = createEventSource()
  const active = { requests: 0 }
  const calls = createFetch((url) => {
    if (url.pathname !== "/api/session/active") return
    active.requests++
    return json({ data: { "session-running": { type: "running" } } })
  }, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  const status = (sessionID: string, value: "busy" | "idle", timestamp: number): Event => ({
    id: `evt_status_${timestamp}`,
    type: "session.next.status.changed",
    properties: { sessionID, status: value, timestamp },
  })

  try {
    await mounted
    expect(data.session.status.get("session-1")).toEqual({ type: "idle" })

    emitEvent(events, status("session-1", "busy", 1))
    await wait(() => data.session.status.get("session-1").type === "busy")
    emitEvent(events, status("session-1", "idle", 2))
    await wait(() => data.session.status.get("session-1").type === "idle")

    // Attaching to a session mid-run seeds from the active set; an already-pushed status is authoritative.
    emitEvent(events, status("session-pushed", "busy", 3))
    await wait(() => data.session.status.get("session-pushed").type === "busy")
    await Promise.all([
      data.session.status.refresh("session-running"),
      data.session.status.refresh("session-quiet"),
      data.session.status.refresh("session-pushed"),
    ])
    expect(active.requests).toBe(3)
    expect(data.session.status.get("session-running")).toEqual({ type: "busy" })
    expect(data.session.status.get("session-quiet")).toEqual({ type: "idle" })
    expect(data.session.status.get("session-pushed")).toEqual({ type: "busy" })

    emitEvent(events, status("session-running", "idle", 4))
    await wait(() => data.session.status.get("session-running").type === "idle")

    // An idle event lost while disconnected is corrected by the reseed on the next connection.
    expect(data.session.status.get("session-pushed")).toEqual({ type: "busy" })
    emitEvent(events, { id: "evt_connected", type: "server.connected", properties: {} })
    await wait(() => data.session.status.get("session-pushed").type === "idle")
    expect(data.session.status.get("session-running")).toEqual({ type: "busy" })
    expect(active.requests).toBe(4)
  } finally {
    app.renderer.destroy()
  }
})

test("records a live V2 turn failure as a transcript message", async () => {
  const events = createEventSource()
  const calls = createFetch(undefined, events)
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <TestData>
            <Probe />
          </TestData>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  const failed: Event = {
    id: "evt_turn_failed_1",
    type: "session.next.turn.failed",
    properties: {
      sessionID: "session-1",
      messageID: "msg_turn_failed_1",
      timestamp: 5,
      error: { type: "unknown", message: "Model unavailable: openrouter/~z-ai/glm-flash-latest" },
    },
  }

  try {
    await mounted
    emitEvent(events, failed)
    await wait(() => data.session.message.list("session-1")?.length === 1)
    expect(data.session.message.list("session-1")?.[0]).toEqual({
      id: "msg_turn_failed_1",
      type: "turn-failed",
      error: { type: "unknown", message: "Model unavailable: openrouter/~z-ai/glm-flash-latest" },
      time: { created: 5 },
    })
    // A redelivered event does not duplicate the marker.
    emitEvent(events, failed)
    await Bun.sleep(20)
    expect(data.session.message.list("session-1")?.length).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { GlobalBus } from "../../src/bus/global"
import { Server } from "../../src/server/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// Each open `/global/event` SSE response holds one GlobalBus listener until its
// request fiber ends, so the listener count is a direct probe for whether the
// server noticed that the client went away. Under Bun 1.3.14 the `node:http`
// compat server never reported a client abort or half-close, which left these
// fibers (and their sockets) alive indefinitely.

const original = {
  flag: Flag.OPENCODE_SERVER_PASSWORD,
  env: process.env.OPENCODE_SERVER_PASSWORD,
}

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = original.flag
  if (original.env === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = original.env
  await disposeAllInstances()
  await resetDatabase()
})

function startListener() {
  Flag.OPENCODE_SERVER_PASSWORD = undefined
  delete process.env.OPENCODE_SERVER_PASSWORD
  return Server.listen({ hostname: "127.0.0.1", port: 0 })
}

async function waitFor(predicate: () => boolean, timeout = 3_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await Bun.sleep(25)
  }
  return predicate()
}

async function openStream(url: URL) {
  const controller = new AbortController()
  const response = await fetch(new URL("/global/event", url), { signal: controller.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain("server.connected")
  return { controller, reader }
}

async function openRawStream(port: number) {
  const socket = net.connect(port, "127.0.0.1")
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  const connected = new Promise<void>((resolve) => {
    const received: string[] = []
    socket.on("data", (chunk) => {
      received.push(chunk.toString("utf8"))
      if (received.join("").includes("server.connected")) resolve()
    })
  })
  socket.write("GET /global/event HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n")
  await connected
  return socket
}

async function connect(port: number) {
  const socket = net.connect(port, "127.0.0.1")
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  return socket
}

function closedWithin(socket: net.Socket, ms: number) {
  return Promise.race([
    new Promise<boolean>((resolve) => socket.once("close", () => resolve(true))),
    Bun.sleep(ms).then(() => false),
  ])
}

async function startLlmServer() {
  const scope = Scope.makeUnsafe()
  const services = await Effect.runPromise(
    Layer.buildWithMemoMap(TestLLMServer.layer, Layer.makeMemoMapUnsafe(), scope),
  )
  return {
    llm: Context.get(services, TestLLMServer),
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.ignore)),
  }
}

describe("HttpApi listener stream teardown", () => {
  test("interrupts SSE request fibers when clients abort mid-stream", async () => {
    const listener = await startListener()
    const baseline = GlobalBus.listenerCount("event")
    try {
      const streams = await Promise.all(Array.from({ length: 8 }, () => openStream(listener.url)))
      expect(await waitFor(() => GlobalBus.listenerCount("event") === baseline + streams.length)).toBe(true)

      streams.forEach((stream) => stream.controller.abort())

      expect(await waitFor(() => GlobalBus.listenerCount("event") === baseline)).toBe(true)
      const response = await fetch(new URL("/global/health", listener.url))
      expect(response.status).toBe(200)
    } finally {
      await listener.stop(true)
    }
  }, 15_000)

  test("tears down a stream when the peer half-closes its socket", async () => {
    const listener = await startListener()
    const baseline = GlobalBus.listenerCount("event")
    try {
      const socket = await openRawStream(listener.port)
      expect(await waitFor(() => GlobalBus.listenerCount("event") === baseline + 1)).toBe(true)

      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
      // Send FIN but keep our read side open, like an aborted client that never
      // destroys its socket.
      socket.end()

      expect(await waitFor(() => GlobalBus.listenerCount("event") === baseline)).toBe(true)
      expect(await Promise.race([closed.then(() => true), Bun.sleep(3_000).then(() => false)])).toBe(true)
    } finally {
      await listener.stop(true)
    }
  }, 15_000)

  test("keeps an idle SSE stream open past the transport idle timeout", async () => {
    const listener = await startListener()
    try {
      const stream = await openStream(listener.url)
      // No events are published, so nothing but the 10s heartbeat flows. The
      // listener must not reap a quiet long-lived stream as an idle connection.
      const next = await Promise.race([
        stream.reader.read().then((chunk) => (chunk.done ? "closed" : "data")),
        Bun.sleep(12_000).then(() => "timeout"),
      ])
      expect(next).toBe("data")
      stream.controller.abort()
    } finally {
      await listener.stop(true)
    }
  }, 20_000)

  test("closes a keep-alive connection when the peer half-closes after a response", async () => {
    const listener = await startListener()
    try {
      const socket = await connect(listener.port)
      const answered = new Promise<void>((resolve) => {
        const received: string[] = []
        socket.on("data", (chunk) => {
          received.push(chunk.toString("utf8"))
          if (received.join("").includes("\r\n\r\n")) resolve()
        })
      })
      socket.write("GET /global/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n")
      await answered
      const closed = closedWithin(socket, 3_000)

      socket.end()

      expect(await closed).toBe(true)
    } finally {
      await listener.stop(true)
    }
  }, 15_000)

  test("tears down a prompt request when the peer half-closes while the provider is mid-stream", async () => {
    const provider = await startLlmServer()
    const release = Promise.withResolvers<void>()
    await Effect.runPromise(provider.llm.push(reply().text("partial").wait(release.promise).streamError("boom")))
    const dir = await tmpdir({ config: testProviderConfig(provider.llm.url) })
    const listener = await startListener()
    try {
      const created = await fetch(new URL(SessionPaths.create, listener.url), {
        method: "POST",
        headers: { "x-opencode-directory": dir.path, "content-type": "application/json" },
        body: JSON.stringify({ title: "mid-stream half-close" }),
      })
      expect(created.status).toBe(200)
      const session = (await created.json()) as { id: string }
      const body = JSON.stringify({
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        parts: [{ type: "text", text: "hello" }],
      })
      const socket = await connect(listener.port)
      socket.write(
        `POST ${SessionPaths.prompt.replace(":sessionID", session.id)} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
          `x-opencode-directory: ${dir.path}\r\ncontent-type: application/json\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
      // The provider has the request and is holding its stream open.
      await Effect.runPromise(provider.llm.wait(1))
      const closed = closedWithin(socket, 3_000)

      socket.end()

      expect(await closed).toBe(true)
      const start = performance.now()
      const health = await fetch(new URL("/global/health", listener.url))
      expect(health.status).toBe(200)
      expect(performance.now() - start).toBeLessThan(2_000)
    } finally {
      release.resolve()
      await listener.stop(true)
      await provider.stop()
      await dir[Symbol.asyncDispose]()
    }
  }, 30_000)
})

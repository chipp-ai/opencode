import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Exit } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MonitorListTool, MonitorStopTool, MonitorTool } from "@/tool/monitor"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Tool } from "@/tool/tool"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer({ experimentalMonitor: true }))
const disabled = testEffect(layer())

const seed = Effect.fn("MonitorToolTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "MonitorTest" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: chat.directory, root: chat.directory },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

/** Records every notification text a monitor delivers into the session. */
function recorder(onPrompt?: (text: string) => Effect.Effect<void>) {
  const texts: string[] = []
  return {
    texts,
    ops: {
      prompt: (input: SessionPrompt.PromptInput) =>
        Effect.gen(function* () {
          const text = input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          texts.push(text)
          if (onPrompt) yield* onPrompt(text)
        }),
    },
  }
}

function context(
  seeded: { chat: Session.Info; assistant: SessionV1.Assistant },
  promptOps: unknown,
  ask: Tool.Context["ask"] = () => Effect.void,
): Tool.Context {
  return {
    sessionID: seeded.chat.id,
    messageID: seeded.assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps },
    messages: [],
    metadata: () => Effect.void,
    ask,
  }
}

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    while (!predicate()) yield* Effect.sleep("50 millis")
  }).pipe(Effect.timeout("8 seconds"))

const tools = Effect.gen(function* () {
  const monitor = yield* (yield* MonitorTool).init()
  const list = yield* (yield* MonitorListTool).init()
  const stop = yield* (yield* MonitorStopTool).init()
  return { monitor, list, stop }
})

const live = (sessionID: string) =>
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    return (yield* jobs.list()).filter(
      (job) => job.type === "monitor" && job.status === "running" && job.metadata?.sessionId === sessionID,
    )
  })

describe("tool.monitor", () => {
  it.instance("arms immediately, delivers output, then an exit notification", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor } = yield* tools
      const rec = recorder()
      const asked: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">[] = []

      const result = yield* monitor.execute(
        { command: "echo hello", description: "greeting" },
        context(seeded, rec.ops, (input) => Effect.sync(() => void asked.push(input))),
      )

      expect(result.output).toContain("Monitor armed")
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ permission: "bash", patterns: ["echo hello"], always: ["echo hello"] })
      yield* waitFor(() => rec.texts.some((text) => text.includes("Monitor exited")))
      expect(rec.texts.some((text) => text.includes("monitor_output") && text.includes("hello"))).toBe(true)
      expect(rec.texts.find((text) => text.includes("Monitor exited"))).toContain("exit code 0")
    }),
  )

  it.instance("only delivers lines matching the pattern", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor } = yield* tools
      const rec = recorder()

      yield* monitor.execute(
        { command: "printf 'noise 1\\nERROR boom\\nnoise 2\\n'", description: "errors", pattern: "^ERROR" },
        context(seeded, rec.ops),
      )

      yield* waitFor(() => rec.texts.some((text) => text.includes("Monitor exited")))
      const output = rec.texts.filter((text) => text.includes("monitor_output")).join("\n")
      expect(output).toContain("ERROR boom")
      expect(output).not.toContain("noise")
    }),
  )

  it.instance("once stops the monitor and kills the command after the first match", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor } = yield* tools
      const jobs = yield* BackgroundJob.Service
      const rec = recorder()

      const result = yield* monitor.execute(
        {
          command: "echo starting; sleep 0.3; echo READY; sleep 30; echo never",
          description: "wait for ready",
          pattern: "READY",
          once: true,
        },
        context(seeded, rec.ops),
      )

      const done = yield* jobs.wait({ id: result.metadata.monitorId, timeout: 8000 })
      expect(done.info).toMatchObject({ status: "completed", output: "matched" })
      yield* waitFor(() => rec.texts.length > 0)
      expect(rec.texts).toHaveLength(1)
      expect(rec.texts[0]).toContain("READY")
      expect(rec.texts[0]).not.toContain("starting")
    }),
  )

  it.instance("runs a multi-line command intact", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor } = yield* tools
      const rec = recorder()
      const command = ["for i in 1 2; do", '  echo "line-$i"', "done"].join("\n")

      yield* monitor.execute({ command, description: "multiline" }, context(seeded, rec.ops))

      yield* waitFor(() => rec.texts.some((text) => text.includes("Monitor exited")))
      const output = rec.texts.join("\n")
      expect(output).toContain("line-1")
      expect(output).toContain("line-2")
      expect(output).toContain("exit code 0")
    }),
  )

  it.instance("re-arming from inside a notification replaces the monitor without deadlocking", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor } = yield* tools
      const jobs = yield* BackgroundJob.Service
      const state = { rearmed: false }
      const ctx = context(seeded, undefined)
      const rec = recorder((text) =>
        Effect.gen(function* () {
          if (state.rearmed || !text.includes("first")) return
          state.rearmed = true
          yield* monitor.execute({ command: "echo rearmed-ok; sleep 30", description: "self-cancel" }, ctx)
        }),
      )
      ctx.extra = { promptOps: rec.ops }

      const first = yield* monitor.execute(
        { command: "echo first; sleep 1; echo second; sleep 30", description: "self-cancel" },
        ctx,
      )

      yield* waitFor(() => rec.texts.some((text) => text.includes("rearmed-ok")))
      expect((yield* jobs.get(first.metadata.monitorId))?.status).toBe("cancelled")
      yield* Effect.sleep("1500 millis")
      expect(rec.texts.some((text) => text.includes("second"))).toBe(false)
      expect(yield* live(seeded.chat.id)).toHaveLength(1)
    }),
  )

  it.instance("distinct descriptions run concurrently and the same description replaces", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor } = yield* tools
      const jobs = yield* BackgroundJob.Service
      const ctx = context(seeded, recorder().ops)

      yield* monitor.execute({ command: "sleep 30", description: "watch-local" }, ctx)
      const remote = yield* monitor.execute({ command: "sleep 30", description: "watch-remote" }, ctx)
      expect(yield* live(seeded.chat.id)).toHaveLength(2)

      yield* monitor.execute({ command: "sleep 30", description: "watch-remote" }, ctx)
      expect(yield* live(seeded.chat.id)).toHaveLength(2)
      expect((yield* jobs.get(remote.metadata.monitorId))?.status).toBe("cancelled")
    }),
  )

  it.instance("monitor_list and monitor_stop inspect and retire monitors", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor, list, stop } = yield* tools
      const ctx = context(seeded, recorder().ops)

      const empty = yield* list.execute({}, ctx)
      expect(empty.output).toContain("No active monitors")

      const a = yield* monitor.execute({ command: "sleep 30", description: "watch-A" }, ctx)
      yield* monitor.execute({ command: "sleep 30", description: "watch-B" }, ctx)
      const listed = yield* list.execute({}, ctx)
      expect(listed.metadata.count).toBe(2)
      expect(listed.metadata.monitors.map((item) => item.description).toSorted()).toEqual(["watch-A", "watch-B"])
      expect(listed.output).toContain("sleep 30")

      const byDescription = yield* stop.execute({ description: "watch-B" }, ctx)
      expect(byDescription.metadata.stopped).toBe(true)
      expect((yield* live(seeded.chat.id)).map((job) => job.metadata?.description)).toEqual(["watch-A"])

      const byID = yield* stop.execute({ id: a.metadata.monitorId }, ctx)
      expect(byID.metadata.stopped).toBe(true)
      expect(yield* live(seeded.chat.id)).toHaveLength(0)

      const missing = yield* stop.execute({ id: "job_missing" }, ctx)
      expect(missing.metadata.stopped).toBe(false)
      expect((yield* stop.execute({}, ctx)).metadata.stopped).toBe(false)
    }),
  )

  it.instance("cancelling the session stops its monitors", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor } = yield* tools
      const runState = yield* SessionRunState.Service
      const jobs = yield* BackgroundJob.Service

      const result = yield* monitor.execute(
        { command: "sleep 30", description: "long" },
        context(seeded, recorder().ops),
      )
      yield* runState.cancel(seeded.chat.id)

      expect((yield* jobs.get(result.metadata.monitorId))?.status).toBe("cancelled")
    }),
  )

  it.instance("truncates an unterminated flood of bytes instead of buffering it", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor } = yield* tools
      const rec = recorder()

      yield* monitor.execute(
        { command: "head -c 2000000 /dev/zero | tr '\\0' x", description: "byte flood" },
        context(seeded, rec.ops),
      )

      yield* waitFor(() => rec.texts.some((text) => text.includes("Monitor exited")))
      const output = rec.texts.filter((text) => text.includes("monitor_output")).join("\n")
      expect(output).toContain("[truncated]")
      expect(output.length).toBeLessThan(10_000)
    }),
  )

  it.instance("stops a watcher that floods lines", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor } = yield* tools
      const jobs = yield* BackgroundJob.Service
      const rec = recorder()

      const result = yield* monitor.execute({ command: "yes", description: "line flood" }, context(seeded, rec.ops))

      const done = yield* jobs.wait({ id: result.metadata.monitorId, timeout: 8000 })
      expect(done.info).toMatchObject({ status: "completed", output: "flood guard" })
      yield* waitFor(() => rec.texts.some((text) => text.includes("[flood guard]")))
    }),
  )

  it.instance("rejects an invalid pattern", () =>
    Effect.gen(function* () {
      const seeded = yield* seed()
      const { monitor } = yield* tools

      const exit = yield* monitor
        .execute({ command: "echo hi", description: "bad", pattern: "(" }, context(seeded, recorder().ops))
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* live(seeded.chat.id)).toHaveLength(0)
    }),
  )

  it.instance("registers monitor tools when the experimental flag is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).toEqual(expect.arrayContaining(["monitor", "monitor_list", "monitor_stop"]))
    }),
  )

  disabled.instance("hides monitor tools unless the experimental flag is enabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).not.toContain("monitor")
      expect(ids).not.toContain("monitor_list")
      expect(ids).not.toContain("monitor_stop")
    }),
  )
})

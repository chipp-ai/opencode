import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProcessTree } from "@opencode-ai/core/util/process-tree"
import { Effect } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { InstanceStore } from "@/project/instance-store"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Real child processes throughout: the fixture server forks a SIGTERM-ignoring grandchild
// and exits synchronously on the LSP "exit" notification, like a server whose helper
// outlives it.
const serverPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server-tree.js")
const IDLE_MS = 300

const it = testEffect(
  LayerNode.compile(LSP.node, [[RuntimeFlags.node, RuntimeFlags.layer({ lspIdleTimeoutMs: IDLE_MS })]]),
)

const treeConfig = {
  git: true,
  config: {
    lsp: {
      tree: {
        command: [process.execPath, serverPath],
        extensions: [".tree"],
      },
    },
  },
}

// Starts the fixture server through the real LSP service and returns the server and
// grandchild pids. The fixture writes the pidfile into its working directory.
const startServer = Effect.gen(function* () {
  const dir = (yield* TestInstance).directory
  const lsp = yield* LSP.Service
  const file = path.join(dir, "sample.tree")
  const pidfile = path.join(dir, "grandchild.pid")
  yield* Effect.promise(() => Bun.write(file, "sample\n"))
  yield* Effect.promise(() => fs.rm(pidfile, { force: true }))
  yield* lsp.touchFile(file)
  expect(yield* lsp.status()).toHaveLength(1)
  const grandchild = yield* Effect.promise(() => readPid(pidfile))
  const rows = yield* Effect.promise(() => ProcessTree.table())
  const server = rows!.find((row) => row.pid === grandchild)!.ppid
  return { lsp, file, server, grandchild }
})

async function readPid(file: string): Promise<number> {
  const text = await fs.readFile(file, "utf8").catch(() => "")
  if (text) return Number(text)
  await Bun.sleep(10)
  return readPid(file)
}

async function waitGone(pid: number, budgetMs = 8_000) {
  const start = Date.now()
  while (ProcessTree.isAlive(pid) && Date.now() - start < budgetMs) await Bun.sleep(25)
  return !ProcessTree.isAlive(pid)
}

describe.skipIf(process.platform === "win32")("LSP process lifecycle", () => {
  it.instance(
    "disposing the instance kills the server and its SIGTERM-ignoring grandchild",
    () =>
      Effect.gen(function* () {
        const started = yield* startServer
        expect(ProcessTree.isAlive(started.server)).toBe(true)
        expect(ProcessTree.isAlive(started.grandchild)).toBe(true)

        const store = yield* InstanceStore.Service
        yield* store.disposeDirectory((yield* TestInstance).directory)

        expect(yield* Effect.promise(() => waitGone(started.server))).toBe(true)
        expect(yield* Effect.promise(() => waitGone(started.grandchild))).toBe(true)
      }),
    treeConfig,
    30_000,
  )

  it.instance(
    "an idle client is shut down with its tree and respawned by the next request",
    () =>
      Effect.gen(function* () {
        const started = yield* startServer

        yield* Effect.promise(() => waitGone(started.grandchild, 10_000))
        expect(ProcessTree.isAlive(started.server)).toBe(false)
        expect(ProcessTree.isAlive(started.grandchild)).toBe(false)
        expect(yield* started.lsp.status()).toEqual([])

        const again = yield* startServer
        expect(again.server).not.toBe(started.server)
        expect(ProcessTree.isAlive(again.server)).toBe(true)
      }),
    treeConfig,
    30_000,
  )

  it.instance(
    "a client in use is not shut down as idle",
    () =>
      Effect.gen(function* () {
        const started = yield* startServer
        // Keep the client busy past several idle windows via repeated requests.
        yield* Effect.forEach(
          Array.from({ length: 8 }),
          () =>
            Effect.gen(function* () {
              yield* Effect.promise(() => Bun.sleep(IDLE_MS / 3))
              yield* started.lsp.hover({ file: started.file, line: 0, character: 0 })
            }),
          { discard: true },
        )
        expect(ProcessTree.isAlive(started.server)).toBe(true)
        expect(ProcessTree.isAlive(started.grandchild)).toBe(true)
      }),
    treeConfig,
    30_000,
  )
})

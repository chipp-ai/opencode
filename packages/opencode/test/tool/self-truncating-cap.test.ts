import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { GrepTool } from "../../src/tool/grep"
import { ReadTool } from "../../src/tool/read"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Instruction } from "../../src/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Git } from "@/git"
import { Config } from "@/config/config"
import { MessageID, SessionID } from "../../src/session/schema"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Config in the caller's context, as in a session: Truncate.limits() reads it from there.
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        Agent.node,
        Config.node,
        CrossSpawnSpawner.node,
        FSUtil.node,
        Git.node,
        Instruction.node,
        LSP.node,
        Ripgrep.node,
        Truncate.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// 80 matching lines of about 1.9 KB each: a 150 KB grep result, the shape
// that passed uncapped in production because grep limits matches, not bytes.
const longLines = Array.from({ length: 80 }, (_, i) => `needle ${i} ${"x".repeat(1900)}`).join("\n")

describe("self-truncating tools under a configured tool_output cap", () => {
  it.instance(
    "grep output over the configured cap is capped again, with the saved path",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "big.txt"), longLines))
        const grep = yield* (yield* GrepTool).init()
        const result = yield* grep.execute({ pattern: "needle", path: test.directory }, ctx)
        expect(Buffer.byteLength(result.output)).toBeLessThan(20_000)
        expect(result.metadata.truncated).toBe(true)
        expect(result.output).toContain("omitted of")
      }),
    { config: { tool_output: { max_bytes: 16_384, max_lines: 1_000, preview: "head_tail" } } },
  )

  it.instance("without tool_output configured, grep output is unchanged", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "big.txt"), longLines))
      const grep = yield* (yield* GrepTool).init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory }, ctx)
      expect(Buffer.byteLength(result.output)).toBeGreaterThan(100_000)
    }),
  )

  it.instance(
    "read pages at the configured byte cap and its offset hint stays exact",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "long.txt")
        yield* Effect.promise(() =>
          Bun.write(file, Array.from({ length: 2_000 }, (_, i) => `row ${i} ${"y".repeat(60)}`).join("\n")),
        )
        const read = yield* (yield* ReadTool).init()
        const first = yield* read.execute({ filePath: file }, ctx)
        expect(Buffer.byteLength(first.output)).toBeLessThan(18_000)
        const hint = /Use offset=(\d+) to continue/.exec(first.output)
        expect(hint).not.toBeNull()
        const next = yield* read.execute({ filePath: file, offset: Number(hint![1]) }, ctx)
        expect(next.output).toContain(`${hint![1]}: row ${Number(hint![1]) - 1} `)
      }),
    { config: { tool_output: { max_bytes: 16_384, max_lines: 1_000 } } },
  )
})

import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProcessTree } from "@opencode-ai/core/util/process-tree"

const posix = process.platform !== "win32"

// Spawns `node` -> child -> grandchild. The grandchild ignores SIGTERM. Resolves with the
// pids once both descendants have written them.
async function spawnTree() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "process-tree-"))
  const pidfile = path.join(dir, "pids")
  const grandchild = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  const child = `
    const { spawn } = require("child_process")
    const fs = require("fs")
    const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" })
    fs.writeFileSync(${JSON.stringify(pidfile)}, process.pid + " " + g.pid)
    setInterval(() => {}, 1000)
  `
  const root = spawn(process.execPath, ["-e", child], { stdio: "ignore" })
  const pids = await waitForPids(pidfile)
  return { root, grandchild: pids[1], dir }
}

async function waitForPids(file: string): Promise<number[]> {
  const text = await fs.readFile(file, "utf8").catch(() => "")
  if (text.includes(" ")) return text.split(" ").map(Number)
  await Bun.sleep(10)
  return waitForPids(file)
}

describe("ProcessTree.parseTable", () => {
  test("parses ps rows, keeping spaces in the command", () => {
    expect(
      ProcessTree.parseTable("  1     0 /sbin/launchd\n 42     1 /Applications/Some App.app/x\nbad line\n"),
    ).toEqual([
      { pid: 1, ppid: 0, comm: "/sbin/launchd" },
      { pid: 42, ppid: 1, comm: "/Applications/Some App.app/x" },
    ])
  })
})

describe("ProcessTree.descendants", () => {
  test("walks every generation breadth first and ignores unrelated processes and cycles", () => {
    const rows = [
      { pid: 10, ppid: 1, comm: "root" },
      { pid: 11, ppid: 10, comm: "a" },
      { pid: 12, ppid: 10, comm: "b" },
      { pid: 13, ppid: 11, comm: "a1" },
      { pid: 20, ppid: 1, comm: "other" },
      { pid: 10, ppid: 13, comm: "cycle" },
    ]
    expect(ProcessTree.descendants(10, rows).map((row) => row.pid)).toEqual([11, 12, 13])
  })
})

describe("ProcessTree.killTree", () => {
  test("refuses pids that kill(2) would broadcast", async () => {
    for (const pid of [0, -1, 1.5, undefined]) {
      expect(await ProcessTree.killTree(pid)).toEqual({ targets: [], survivors: [], treeKnown: false })
    }
  })

  test.skipIf(!posix)("kills the root and a SIGTERM-ignoring grandchild", async () => {
    const tree = await spawnTree()
    expect(ProcessTree.isAlive(tree.grandchild)).toBe(true)

    const result = await ProcessTree.killTree(tree.root.pid, { graceMs: 300 })

    expect(result.treeKnown).toBe(true)
    expect(result.targets).toContain(tree.root.pid!)
    expect(result.targets).toContain(tree.grandchild)
    expect(result.survivors).toEqual([])
    expect(ProcessTree.isAlive(tree.grandchild)).toBe(false)
    await fs.rm(tree.dir, { recursive: true, force: true })
  })

  test.skipIf(!posix)("kills a grandchild already reparented to init when given a table read earlier", async () => {
    const tree = await spawnTree()
    const rows = await ProcessTree.table()
    const child = rows!.find((row) => row.ppid === tree.root.pid)!.pid
    // Kill only the intermediate process: its SIGTERM-ignoring child is orphaned and
    // invisible to a fresh ppid walk from the root.
    process.kill(child, "SIGKILL")
    while (ProcessTree.isAlive(child)) await Bun.sleep(10)
    const fresh = await ProcessTree.table()
    expect(ProcessTree.descendants(tree.root.pid!, fresh!).map((row) => row.pid)).not.toContain(tree.grandchild)

    const result = await ProcessTree.killTree(tree.root.pid, { rows, graceMs: 300 })

    expect(result.targets).toContain(tree.grandchild)
    expect(result.survivors).toEqual([])
    expect(ProcessTree.isAlive(tree.grandchild)).toBe(false)
    await fs.rm(tree.dir, { recursive: true, force: true })
  })
})

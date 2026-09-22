import { describe, expect, it } from "bun:test"
import { WorkflowSandbox } from "@opencode-ai/core/workflow/sandbox"

const noopGlobals = {
  agent: async () => "unused",
  parallel: async () => [],
  pipeline: async () => [],
  phase: () => {},
  log: () => {},
  budget: { total: null, spent: () => 0, remaining: () => Infinity },
  args: undefined,
}

describe("WorkflowSandbox.run", () => {
  it("returns the script's top-level return value", async () => {
    const result = await WorkflowSandbox.run("return 1 + 1", noopGlobals)
    expect(result).toBe(2)
  })

  it("exposes agent/parallel/pipeline/phase/log/budget/args as bare globals", async () => {
    const calls: string[] = []
    const result = await WorkflowSandbox.run(
      `
      phase("Research")
      log("starting")
      const a = await agent("hi")
      const p = await parallel([() => agent("one")])
      const pipe = await pipeline([1], async (_prev, item) => item * 2)
      return { a, p, pipe, budgetTotal: budget.total, args }
      `,
      {
        ...noopGlobals,
        agent: async (prompt: string) => {
          calls.push(prompt)
          return `echo:${prompt}`
        },
        parallel: async (thunks: ReadonlyArray<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t())),
        pipeline: async (items: ReadonlyArray<unknown>, ...stages: ReadonlyArray<(p: unknown, i: unknown, x: number) => Promise<unknown>>) =>
          Promise.all(items.map(async (item, index) => {
            let value: unknown
            for (const stage of stages) value = await stage(value, item, index)
            return value
          })),
        phase: (title: string) => calls.push(`phase:${title}`),
        log: (message: string) => calls.push(`log:${message}`),
        budget: { total: 5, spent: () => 0, remaining: () => 5 },
        args: { seed: 42 },
      },
    )
    expect(result).toEqual({ a: "echo:hi", p: ["echo:one"], pipe: [2], budgetTotal: 5, args: { seed: 42 } })
    expect(calls).toEqual(["phase:Research", "log:starting", "hi", "one"])
  })

  it("has no access to process, require, fetch, or console -- they are ReferenceErrors, not just empty", async () => {
    for (const identifier of ["process", "require", "fetch", "console", "Buffer", "__dirname", "__filename"]) {
      await expect(WorkflowSandbox.run(`return typeof ${identifier}`, noopGlobals)).resolves.toBe("undefined")
    }
    await expect(WorkflowSandbox.run("return process.env", noopGlobals)).rejects.toThrow(/process is not defined/)
  })

  it("Date.now() and argless `new Date()` throw a resume-safety error; a timestamped Date still works", async () => {
    await expect(WorkflowSandbox.run("return Date.now()", noopGlobals)).rejects.toThrow(/break journal-based resume/)
    await expect(WorkflowSandbox.run("return new Date()", noopGlobals)).rejects.toThrow(/break journal-based resume/)
    const result = await WorkflowSandbox.run("return new Date(0).getUTCFullYear()", noopGlobals)
    expect(result).toBe(1970)
  })

  it("Math.random() throws a resume-safety error; other Math methods still work", async () => {
    await expect(WorkflowSandbox.run("return Math.random()", noopGlobals)).rejects.toThrow(/break journal-based resume/)
    const result = await WorkflowSandbox.run("return Math.max(1, 2, 3)", noopGlobals)
    expect(result).toBe(3)
  })
})

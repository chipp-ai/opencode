export * as WorkflowSandbox from "./sandbox"

import vm from "node:vm"

/**
 * The bare-globals a workflow script sees, matching the real Workflow tool's contract
 * (agent/parallel/pipeline/phase/log/budget/args as ambient identifiers, no `ctx.` prefix) --
 * see the `workflow-authoring` skill. `workflow()` (running another workflow inline) is not
 * implemented -- this engine has no saved-workflow registry to resolve a name against yet
 * (Phase 5).
 */
export type Globals = {
  readonly agent: (prompt: string, opts?: unknown) => Promise<unknown>
  readonly parallel: (thunks: ReadonlyArray<() => Promise<unknown>>) => Promise<unknown[]>
  readonly pipeline: (
    items: ReadonlyArray<unknown>,
    ...stages: ReadonlyArray<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
  ) => Promise<unknown[]>
  readonly phase: (title: string) => void
  readonly log: (message: string) => void
  readonly budget: unknown
  readonly args: unknown
}

class ResumeUnsafeError extends Error {
  constructor(what: string) {
    super(`${what} is disallowed in workflow scripts -- it would break journal-based resume. Pass a timestamp via \`args\` instead.`)
  }
}

/** Real Date, but Date.now() and argless `new Date()` throw -- both are nondeterministic across a resumed run. */
class SandboxDate extends Date {
  constructor(...args: readonly unknown[]) {
    if (args.length === 0) throw new ResumeUnsafeError("new Date() with no arguments")
    super(...(args as unknown as ConstructorParameters<typeof Date>))
  }
  static override now(): number {
    throw new ResumeUnsafeError("Date.now()")
  }
}

const sandboxMath = new Proxy(Math, {
  get(target, prop, receiver) {
    if (prop === "random") throw new ResumeUnsafeError("Math.random()")
    return Reflect.get(target, prop, receiver)
  },
})

/**
 * Runs a workflow script's source text in an isolated V8 context (`vm.createContext`) with only
 * the workflow globals exposed -- no `process`, `require`, `fetch`, `Buffer`, `console`, or
 * filesystem access, since a fresh vm context starts as its own realm with none of those and
 * this function never adds them. This fixes the community bare-globals branch's actual security
 * bug (unsandboxed `new Function` in the *host* global scope, where all of that stays reachable)
 * and its separate correctness bug (`pipeline` was documented but never actually injected).
 *
 * Node's `vm` module is explicitly documented as not a security boundary against a truly
 * malicious script (known V8-context escape techniques exist) -- this is "don't let an honest
 * mistake in a checked-in `.opencode/workflows/*.js` file touch the filesystem or network by
 * accident," not a sandbox for untrusted third-party code.
 *
 * The script's source is wrapped as an async function body, so a top-level `return <value>`
 * becomes the resolved result -- matching how the real Workflow tool treats a script.
 */
export function run(source: string, globals: Globals): Promise<unknown> {
  const context = vm.createContext(
    // Bun's `vm` shim (unlike Node's) exposes `console` in a fresh context by default even
    // though it's a Node/Bun-runtime global, not a standard one -- override it explicitly to
    // close that gap rather than relying on vm.createContext's isolation alone.
    { ...globals, Date: SandboxDate, Math: sandboxMath, console: undefined },
    { name: "opencode-workflow-sandbox" },
  )
  const script = new vm.Script(`(async () => {\n${source}\n})()`, { filename: "workflow.js" })
  return script.runInContext(context)
}

export * as WorkflowDiscovery from "./discovery"

import path from "node:path"
import vm from "node:vm"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import { AbsolutePath } from "../schema"
import type { Workflow } from "@opencode-ai/schema/workflow"

/**
 * Scans `<directory>/.opencode/workflows/*.js` for workflow scripts. Each file's metadata comes
 * from a leading `export const meta = {...}` literal, extracted and evaluated in its own
 * completely empty `vm` context -- never executing the rest of the file just to list it. This
 * mirrors the community meta-reader/source-lint design's actual goal (metadata without running
 * the module), reimplemented here since their AST-based version is fused to a different parser
 * dependency; the "pure literal" constraint the `workflow-authoring` skill already requires of
 * `meta` (no variables, calls, or interpolation) is exactly what makes evaluating it alone safe.
 *
 * A file with no leading meta export, or one that isn't a valid `{name, description}` object,
 * is reported as a lint error rather than failing discovery for every other file in the
 * directory.
 */
export const list = Effect.fn("WorkflowDiscovery.list")(function* (directory: string) {
  const fs = yield* FSUtil.Service
  const dir = path.join(directory, ".opencode", "workflows")
  if (!(yield* fs.existsSafe(dir))) return { workflows: [] as Workflow.Info[], errors: [] as Workflow.LintError[] }

  const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.orDie)
  const files = entries.filter((entry) => entry.type === "file" && entry.name.endsWith(".js"))

  const parsed = yield* Effect.forEach(files, (entry) =>
    Effect.gen(function* () {
      const filePath = path.join(dir, entry.name)
      const source = yield* fs.readFileStringSafe(filePath).pipe(Effect.orDie)
      return source === undefined
        ? { error: { path: AbsolutePath.make(filePath), message: "could not read file" } }
        : parseWorkflowFile(filePath, source)
    }),
  )

  return {
    workflows: parsed.flatMap((item) => ("workflow" in item ? [item.workflow] : [])),
    errors: parsed.flatMap((item) => ("error" in item ? [item.error] : [])),
  }
})

export const find = Effect.fn("WorkflowDiscovery.find")(function* (directory: string, id: string) {
  const { workflows } = yield* list(directory)
  return workflows.find((workflow) => workflow.id === id)
})

/** The script source with its leading `export const meta = {...}` stripped, ready for `WorkflowSandbox.run`/`WorkflowEngine.runSource`. */
export const readBody = Effect.fn("WorkflowDiscovery.readBody")(function* (filePath: string) {
  const fs = yield* FSUtil.Service
  const source = yield* fs.readFileStringSafe(filePath).pipe(Effect.orDie)
  if (source === undefined) return yield* Effect.die(new Error(`workflow file not found: ${filePath}`))
  const found = findMetaExport(source)
  return found ? source.slice(found.bodyStart) : source
})

function parseWorkflowFile(
  filePath: string,
  source: string,
): { workflow: Workflow.Info } | { error: Workflow.LintError } {
  const found = findMetaExport(source)
  if (!found) {
    return { error: { path: AbsolutePath.make(filePath), message: "missing a leading `export const meta = {...}` literal" } }
  }
  try {
    const meta = vm.runInNewContext(`(${found.metaLiteral})`, {}, { timeout: 100 })
    if (typeof meta !== "object" || meta === null) throw new Error("meta is not an object")
    if (typeof meta.name !== "string" || !meta.name) throw new Error("meta.name is required")
    if (typeof meta.description !== "string" || !meta.description) throw new Error("meta.description is required")
    const id = path.basename(filePath, ".js")
    return { workflow: { id: id as Workflow.ID, name: meta.name, description: meta.description, path: AbsolutePath.make(filePath) } }
  } catch (error) {
    return {
      error: {
        path: AbsolutePath.make(filePath),
        message: `invalid meta: ${error instanceof Error ? error.message : String(error)}`,
      },
    }
  }
}

/** Finds a leading `export const meta = {...}` statement and returns its literal text plus where the remaining script body starts. */
function findMetaExport(source: string): { metaLiteral: string; bodyStart: number } | undefined {
  const prefix = /^export\s+const\s+meta\s*=\s*/.exec(source)
  if (!prefix) return undefined
  const braceStart = prefix[0].length
  if (source[braceStart] !== "{") return undefined
  const braceEnd = findBalancedBraceEnd(source, braceStart)
  if (braceEnd === undefined) return undefined
  const semi = /^\s*;?/.exec(source.slice(braceEnd + 1))
  return { metaLiteral: source.slice(braceStart, braceEnd + 1), bodyStart: braceEnd + 1 + (semi?.[0].length ?? 0) }
}

/** Scans forward from an opening `{` to its matching `}`, respecting string/template literal boundaries. */
function findBalancedBraceEnd(source: string, openIndex: number): number | undefined {
  let depth = 0
  let quote: string | undefined
  for (let i = openIndex; i < source.length; i++) {
    const char = source[i]
    if (quote) {
      if (char === "\\") {
        i++
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return undefined
}

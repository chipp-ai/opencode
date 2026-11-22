import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { evaluate } from "@/permission/evaluate"
import { Config } from "@/config/config"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"

const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail" | "head_tail"
}

export interface Limits {
  maxLines: number
  maxBytes: number
  /** `tool_output.preview`: the direction used when a caller does not pass one. */
  preview?: "head" | "head_tail"
  /** `tool_output.max_attachments`; undefined means no limit. */
  maxAttachments?: number
  /** `tool_output.max_instruction_bytes`; undefined means no limit. */
  maxInstructionBytes?: number
  /** True when `tool_output.max_bytes` or `max_lines` is set: the cap then applies to every tool. */
  configured?: boolean
}

function take(lines: string[], maxLines: number, maxBytes: number, fromEnd: boolean) {
  const out: string[] = []
  let bytes = 0
  let hitBytes = false
  for (let n = 0; n < lines.length && out.length < maxLines; n++) {
    const line = fromEnd ? lines[lines.length - 1 - n] : lines[n]
    const size = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      hitBytes = true
      break
    }
    if (fromEnd) out.unshift(line)
    else out.push(line)
    bytes += size
  }
  return { out, bytes, hitBytes }
}

/**
 * Pure: an instruction file's text for a read result, cut to `maxBytes` (whole
 * when `maxBytes` is undefined or the text fits). A cut file ends with its
 * path and size, so the agent can read the rest with offset/limit.
 */
export function capInstruction(item: { filepath: string; content: string }, maxBytes: number | undefined) {
  const total = Buffer.byteLength(item.content, "utf-8")
  if (maxBytes === undefined || total <= maxBytes) return item.content
  const kept = take(item.content.split("\n"), Number.MAX_SAFE_INTEGER, maxBytes, false)
  return `${kept.out.join("\n")}\n\n(Instruction file cut: showing ${kept.bytes} of ${total} bytes. Read ${item.filepath} with offset/limit for the rest, or Grep it for a topic.)`
}

/**
 * Pure: keep at most `max` attachments of one tool result (all of them when
 * `max` is undefined). The note tells the model how many were dropped, so it
 * can ask for one at a time instead of reading the result as complete.
 */
export function capAttachments<T>(attachments: readonly T[] | undefined, max: number | undefined) {
  const list = attachments ?? []
  if (max === undefined || list.length <= max) return { kept: attachments, note: "" }
  const dropped = list.length - max
  return {
    kept: list.slice(0, max),
    note: `\n\n(${dropped} of ${list.length} attachments omitted: one tool result keeps at most ${max}. Ask for the others one at a time.)`,
  }
}

/**
 * Pure: the first and last parts of `text`, each within half the limits, with
 * the counts of what was left out. Lines never repeat between the two parts.
 */
export function headTail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  const halfLines = Math.max(1, Math.floor(maxLines / 2))
  const halfBytes = Math.max(1, Math.floor(maxBytes / 2))
  const head = take(lines, halfLines, halfBytes, false)
  const rest = lines.slice(head.out.length)
  const tail = take(rest, halfLines, halfBytes, true)
  const omittedLines = lines.length - head.out.length - tail.out.length
  const totalBytes = Buffer.byteLength(text, "utf-8")
  return {
    head: head.out.join("\n"),
    tail: tail.out.join("\n"),
    omittedLines,
    omittedBytes: Math.max(0, totalBytes - head.bytes - tail.bytes - (tail.out.length > 0 ? 1 : 0)),
    totalLines: lines.length,
    totalBytes,
  }
}

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<Limits>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        const file = path.join(TRUNCATION_DIR, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const mtime = info && Option.getOrUndefined(info.mtime)
        if (!mtime || mtime.getTime() >= cutoff) continue
        yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES, preview: "head" } satisfies Limits
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
        preview: cfg?.tool_output?.preview ?? "head",
        maxAttachments: cfg?.tool_output?.max_attachments,
        maxInstructionBytes: cfg?.tool_output?.max_instruction_bytes,
        configured: cfg?.tool_output?.max_bytes !== undefined || cfg?.tool_output?.max_lines !== undefined,
      } satisfies Limits
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction === "tail" ? "tail" : "head"
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      const hintFor = (file: string) =>
        hasTaskTool(agent)
          ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
          : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

      if ((options.direction ?? resolved.preview) === "head_tail") {
        const cut = headTail(text, maxLines, maxBytes)
        const file = yield* write(text)
        return {
          content: [
            cut.head,
            "",
            `...${cut.omittedLines} lines (${cut.omittedBytes} bytes) omitted of ${cut.totalLines} lines (${cut.totalBytes} bytes)...`,
            "",
            hintFor(file),
            "",
            cut.tail,
          ].join("\n"),
          truncated: true,
          outputPath: file,
        } as const
      }

      const out: string[] = []
      let i = 0
      let bytes = 0
      let hitBytes = false

      if (direction === "head") {
        for (i = 0; i < lines.length && i < maxLines; i++) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.push(lines[i])
          bytes += size
        }
      } else {
        for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.unshift(lines[i])
          bytes += size
        }
      }

      const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
      const unit = hitBytes ? "bytes" : "lines"
      const preview = out.join("\n")
      const file = yield* write(text)

      const hint = hintFor(file)

      return {
        content:
          direction === "head"
            ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
            : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`,
        truncated: true,
        outputPath: file,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => Effect.logError("truncation cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node] })

export * as Truncate from "./truncate"

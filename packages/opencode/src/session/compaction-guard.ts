import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { count, trigger } from "./overflow"

/**
 * Loop guards for automatic compaction. Pure: reads the session's messages,
 * no I/O.
 *
 * A compaction cannot remove the system prompt, the tool schemas, its own
 * summary or the turns it keeps. When those already read close to the
 * trigger, the next step overflows again, compacts again and continues
 * again, in a loop (one production session compacted 150 times in 45
 * minutes with a trigger about 6K tokens above that floor). Two checks stop
 * it:
 *
 * - `compaction.min_steps_between`: an automatic compaction needs at least
 *   this many finished model steps since the previous compaction.
 * - `compaction.floor_margin`: the first step after a compaction reads the
 *   floor. When the floor is at least `trigger x (1 - floor_margin)`, a
 *   compaction does not make enough room, so automatic compaction stays off
 *   until a compaction lowers the floor (a manual one, for example).
 *
 * A refusal never compacts. The session goes on and stops at the model's
 * real limit, as with `compaction.auto: false`.
 */

export type Verdict =
  | { allow: true }
  | { allow: false; reason: "min_steps"; steps: number; required: number }
  | { allow: false; reason: "floor"; floor: number; limit: number; trigger: number }

type Info = SessionV1.WithParts["info"]

function isCompactionSummary(info: Info) {
  return info.role === "assistant" && info.summary === true && !!info.finish && !info.error
}

export function guard(input: {
  cfg: ConfigV1.Info
  model: Provider.Model
  outputTokenMax?: number
  /** The session's messages, oldest first. */
  messages: readonly Info[]
  /** A finished step not yet in `messages` (the one that asked to compact). */
  current?: Info
}): Verdict {
  const minSteps = input.cfg.compaction?.min_steps_between
  const margin = input.cfg.compaction?.floor_margin
  if (minSteps === undefined && margin === undefined) return { allow: true }

  const all = input.current ? [...input.messages.filter((m) => m.id !== input.current!.id), input.current] : input.messages
  let last = -1
  for (let i = all.length - 1; i >= 0; i--) {
    if (isCompactionSummary(all[i])) {
      last = i
      break
    }
  }
  if (last === -1) return { allow: true }

  const steps = all
    .slice(last + 1)
    .filter((m): m is SessionV1.Assistant => m.role === "assistant" && m.summary !== true && !!m.finish)

  if (minSteps !== undefined && steps.length < minSteps) {
    return { allow: false, reason: "min_steps", steps: steps.length, required: minSteps }
  }

  if (margin !== undefined && steps.length > 0) {
    const at = trigger(input)
    const floor = count(steps[0].tokens)
    const limit = Math.floor(at * (1 - margin))
    if (floor >= limit) return { allow: false, reason: "floor", floor, limit, trigger: at }
  }
  return { allow: true }
}

export * as CompactionGuard from "./compaction-guard"

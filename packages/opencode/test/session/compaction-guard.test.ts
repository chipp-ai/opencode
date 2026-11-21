import { describe, test, expect } from "bun:test"
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { CompactionGuard } from "@/session/compaction-guard"
import { isOverflow, trigger } from "@/session/overflow"

function model(context: number, output: number, input?: number): Provider.Model {
  return { id: "m", providerID: "p", name: "m", limit: { context, output, input } } as unknown as Provider.Model
}

let seq = 0
function tokens(total: number): SessionV1.Assistant["tokens"] {
  return { total, input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}
function step(total: number, summary = false): SessionV1.WithParts["info"] {
  seq++
  return {
    id: `msg_${String(seq).padStart(6, "0")}`,
    role: "assistant",
    sessionID: "ses",
    parentID: "u",
    time: { created: seq },
    tokens: tokens(total),
    finish: "tool-calls",
    summary,
  } as unknown as SessionV1.WithParts["info"]
}

const cfg = (compaction: NonNullable<ConfigV1.Info["compaction"]>) => ({ compaction }) as ConfigV1.Info

describe("overflow trigger", () => {
  test("threshold is a fraction of the usable window; absent means the whole usable window", () => {
    const m = model(1_000_000, 64_000)
    expect(trigger({ cfg: cfg({}), model: m })).toBe(1_000_000 - 32_000)
    expect(trigger({ cfg: cfg({ threshold: 0.8 }), model: m })).toBe(Math.floor((1_000_000 - 32_000) * 0.8))
  })

  test("auto false never overflows, whatever the threshold", () => {
    expect(
      isOverflow({ cfg: cfg({ auto: false, threshold: 0.1 }), model: model(1_000_000, 64_000), tokens: tokens(999_000) }),
    ).toBe(false)
  })
})

describe("CompactionGuard.guard", () => {
  const m = model(1_000_000, 64_000)

  test("no guard keys: always allowed (upstream behavior)", () => {
    expect(CompactionGuard.guard({ cfg: cfg({}), model: m, messages: [step(100_000, true), step(990_000)] })).toEqual({
      allow: true,
    })
  })

  test("no previous compaction: allowed", () => {
    expect(
      CompactionGuard.guard({ cfg: cfg({ min_steps_between: 10, floor_margin: 0.5 }), model: m, messages: [step(800_000)] })
        .allow,
    ).toBe(true)
  })

  test("min_steps_between refuses a compaction too soon after the last one", () => {
    const messages = [step(50_000, true), step(200_000), step(210_000)]
    const v = CompactionGuard.guard({ cfg: cfg({ min_steps_between: 3 }), model: m, messages })
    expect(v).toEqual({ allow: false, reason: "min_steps", steps: 2, required: 3 })
    const later = CompactionGuard.guard({
      cfg: cfg({ min_steps_between: 3 }),
      model: m,
      messages: [...messages, step(220_000)],
    })
    expect(later.allow).toBe(true)
  })

  test("the current step counts toward min_steps_between", () => {
    const messages = [step(50_000, true), step(200_000)]
    const v = CompactionGuard.guard({
      cfg: cfg({ min_steps_between: 2 }),
      model: m,
      messages,
      current: step(210_000) as SessionV1.Assistant,
    })
    expect(v.allow).toBe(true)
  })

  test("floor_margin refuses when the first step after a compaction already sits near the trigger", () => {
    const at = trigger({ cfg: cfg({ threshold: 0.8 }), model: m })
    const v = CompactionGuard.guard({
      cfg: cfg({ threshold: 0.8, floor_margin: 0.5 }),
      model: m,
      messages: [step(80_000, true), step(Math.floor(at * 0.6)), step(at + 1)],
    })
    expect(v.allow).toBe(false)
    if (!v.allow && v.reason === "floor") expect(v.limit).toBe(Math.floor(at * 0.5))
  })

  test("a healthy floor far below the trigger is allowed", () => {
    const v = CompactionGuard.guard({
      cfg: cfg({ threshold: 0.8, floor_margin: 0.5, min_steps_between: 5 }),
      model: m,
      messages: [step(80_000, true), ...Array.from({ length: 40 }, (_, i) => step(130_000 + i * 17_000))],
    })
    expect(v.allow).toBe(true)
  })
})

/**
 * The 2026-10-26 loop shape: a trigger (limit.input 140K minus the 20K
 * reserve, 120K) below the post-compaction floor (126K). Each simulated step
 * applies the fork's own overflow check, then the guard; a compaction resets
 * the next step's input to the floor.
 */
function simulate(c: ConfigV1.Info, mdl: Provider.Model, floor: number, perStep: number, steps: number) {
  const messages: SessionV1.WithParts["info"][] = [step(floor, true)]
  let context = floor
  let compactions = 0
  for (let i = 0; i < steps; i++) {
    const s = step(context)
    messages.push(s)
    if (isOverflow({ cfg: c, model: mdl, tokens: s.role === "assistant" ? s.tokens : tokens(0) })) {
      if (CompactionGuard.guard({ cfg: c, model: mdl, messages }).allow) {
        compactions++
        messages.push(step(floor, true))
        context = floor
        continue
      }
    }
    context += perStep
  }
  return compactions
}

describe("2026-10-26 compaction loop", () => {
  const capped = model(1_000_000, 64_000, 140_000)

  test("reproduces: without guards a trigger below the floor compacts on every step", () => {
    expect(simulate(cfg({ auto: true }), capped, 126_000, 2_000, 60)).toBe(60)
  })

  test("with floor_margin the same shape compacts at most once more, never in a loop", () => {
    expect(simulate(cfg({ auto: true, floor_margin: 0.5 }), capped, 126_000, 2_000, 60)).toBe(0)
  })

  test("with min_steps_between alone it compacts at most once per N steps", () => {
    const n = simulate(cfg({ auto: true, min_steps_between: 20 }), capped, 126_000, 2_000, 60)
    expect(n).toBeLessThanOrEqual(3)
  })

  test("the shipped shape (full 1M window, 0.8 threshold) compacts only near 80% fill", () => {
    const full = model(1_000_000, 64_000)
    const c = cfg({ auto: true, threshold: 0.8, min_steps_between: 8, floor_margin: 0.5 })
    expect(simulate(c, full, 126_000, 2_000, 300)).toBe(0)
    expect(simulate(c, full, 126_000, 10_000, 300)).toBeGreaterThanOrEqual(3)
  })
})

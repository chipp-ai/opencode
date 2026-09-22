import { describe, expect, it } from "bun:test"
import { WorkflowJournal } from "@opencode-ai/core/workflow/journal"

const result = (text: string, cost = 0.01) => ({ sessionID: "ses_x", text, cost })

describe("WorkflowJournal.makeReplay", () => {
  it("with no prior journal, every check misses and record builds a fresh journal", () => {
    const replay = WorkflowJournal.makeReplay(undefined)
    expect(replay.check({ prompt: "a", opts: null })).toBeNull()
    replay.record({ prompt: "a", opts: null }, result("a-result"))
    expect(replay.check({ prompt: "b", opts: null })).toBeNull()
    replay.record({ prompt: "b", opts: null }, result("b-result"))
    expect(replay.entries()).toEqual([
      { index: 0, key: { prompt: "a", opts: null }, result: result("a-result") },
      { index: 1, key: { prompt: "b", opts: null }, result: result("b-result") },
    ])
    expect(replay.cachedCost).toBe(0)
  })

  it("replays an unchanged prefix from a prior journal", () => {
    const previous = [
      { index: 0, key: { prompt: "a", opts: null }, result: result("a-result", 0.02) },
      { index: 1, key: { prompt: "b", opts: null }, result: result("b-result", 0.03) },
    ]
    const replay = WorkflowJournal.makeReplay(previous)

    expect(replay.check({ prompt: "a", opts: null })).toEqual(result("a-result", 0.02))
    expect(replay.check({ prompt: "b", opts: null })).toEqual(result("b-result", 0.03))
    expect(replay.cachedCost).toBeCloseTo(0.05, 10)
    expect(replay.entries()).toEqual(previous)
  })

  it("diverges on the first mismatched call and dispatches everything after live", () => {
    const previous = [
      { index: 0, key: { prompt: "a", opts: null }, result: result("a-result") },
      { index: 1, key: { prompt: "b", opts: null }, result: result("b-result") },
    ]
    const replay = WorkflowJournal.makeReplay(previous)

    expect(replay.check({ prompt: "a", opts: null })).toEqual(result("a-result"))
    // Second call's prompt changed -- diverges here.
    expect(replay.check({ prompt: "b-edited", opts: null })).toBeNull()
    replay.record({ prompt: "b-edited", opts: null }, result("b-edited-result"))
    // Even though the third call's prompt matches the OLD journal's (nonexistent) third entry
    // shape, once diverged everything runs live.
    expect(replay.check({ prompt: "c", opts: null })).toBeNull()
    replay.record({ prompt: "c", opts: null }, result("c-result"))

    expect(replay.entries()).toEqual([
      { index: 0, key: { prompt: "a", opts: null }, result: result("a-result") },
      { index: 1, key: { prompt: "b-edited", opts: null }, result: result("b-edited-result") },
      { index: 2, key: { prompt: "c", opts: null }, result: result("c-result") },
    ])
  })

  it("diverges when the resumed run has fewer calls than this run needs", () => {
    const previous = [{ index: 0, key: { prompt: "a", opts: null }, result: result("a-result") }]
    const replay = WorkflowJournal.makeReplay(previous)

    expect(replay.check({ prompt: "a", opts: null })).toEqual(result("a-result"))
    expect(replay.check({ prompt: "b", opts: null })).toBeNull()
  })

  it("treats different opts as a different key even with the same prompt", () => {
    const previous = [{ index: 0, key: { prompt: "a", opts: { model: "x" } }, result: result("a-result") }]
    const replay = WorkflowJournal.makeReplay(previous)

    expect(replay.check({ prompt: "a", opts: { model: "y" } })).toBeNull()
  })
})
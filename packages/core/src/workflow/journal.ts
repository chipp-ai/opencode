export * as WorkflowJournal from "./journal"

import type { WorkflowJournalEntry } from "./sql"

export type Key = WorkflowJournalEntry["key"]
export type Result = WorkflowJournalEntry["result"]

/** Prompt+opts must serialize identically for a resumed call to count as unchanged. */
const sameKey = (a: Key, b: Key): boolean => a.prompt === b.prompt && JSON.stringify(a.opts) === JSON.stringify(b.opts)

/**
 * Positional cache for resuming a workflow run: the Nth `agent()` call this run makes is checked
 * against the Nth entry of the prior run's journal, and reused verbatim when its (prompt, opts)
 * key matches -- "same script + same args -> 100% cache hit" for the unchanged prefix. The first
 * mismatch (an edited call, or the prior run simply hadn't reached this point yet) marks the run
 * as diverged; every call from that point on, including ones that would otherwise have matched
 * further down the old journal, dispatches live.
 *
 * Known limitation: position is assigned by call order (`next.length` at `check()` time), which
 * is deterministic for a script that sequentially `await`s `agent()` calls, but is NOT guaranteed
 * to align with source order for calls made inside a single `parallel()`/`pipeline()` batch,
 * since those dispatch concurrently and `check()` fires when each call actually starts, not when
 * the script issued it. Worst case this causes extra live re-dispatches within a batch (a real
 * key mismatch is always caught correctly); the narrow remaining risk is two calls in the same
 * batch sharing an identical (prompt, opts) key swapping which cached result each receives --
 * harmless for genuinely interchangeable calls, a real (if rare) correctness gap otherwise.
 * Tracked as a follow-up in FORK_CHANGES.md rather than silently assumed away.
 */
export type Replay = {
  /**
   * Call synchronously at each `agent()` call site, before dispatching. Returns the cached
   * result when this call's position and key match the resumed journal; `null` means dispatch
   * live -- and every call from here on in this run also dispatches live, even if a later
   * position would have otherwise matched (the script diverged at this point, so nothing after
   * it can be trusted against the old journal).
   */
  readonly check: (key: Key) => Result | null
  /** Call after a live dispatch completes, to extend the journal this run will persist. */
  readonly record: (key: Key, result: Result) => void
  /** The journal to persist for this run (cached prefix + newly recorded entries). */
  readonly entries: () => ReadonlyArray<WorkflowJournalEntry>
  /** Sum of every cached entry's cost -- seeds a resumed run's budget.spent() correctly. */
  readonly cachedCost: number
}

/** `previous` is the prior run's journal when resuming, or `undefined` for a fresh run. */
export const makeReplay = (previous: ReadonlyArray<WorkflowJournalEntry> | undefined): Replay => {
  let diverged = previous === undefined
  const next: WorkflowJournalEntry[] = []
  const cachedCost = (previous ?? []).reduce((sum, entry) => sum + entry.result.cost, 0)

  return {
    check(key) {
      const position = next.length
      if (diverged) return null
      const candidate = previous?.[position]
      if (!candidate || !sameKey(candidate.key, key)) {
        diverged = true
        return null
      }
      next.push(candidate)
      return candidate.result
    },
    record(key, result) {
      next.push({ index: next.length, key, result })
    },
    entries: () => next,
    cachedCost,
  }
}

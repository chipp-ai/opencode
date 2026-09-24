// Reference counting plus an idle clock over an opaque set of keys.
//
// A key is busy while any holder has acquired it and not yet released. Once the last
// holder releases, the key's idle clock runs; `idle` names keys with no holder and no
// activity for at least the given window. The tracker owns no resource: the caller decides
// what eviction means and calls `forget` once the resource is gone.
//
// Timestamps are passed in so Effect callers can read them from `Clock`.

interface Entry {
  holders: number
  lastActivityAt: number
}

export class Tracker<K> {
  readonly #entries = new Map<K, Entry>()

  /** Mark `key` busy until the returned release runs. Release is idempotent, and a release
   *  for an entry that was forgotten in between is ignored. */
  acquire(key: K, now: number) {
    const entry = this.#entry(key, now)
    entry.holders += 1
    entry.lastActivityAt = now
    const state = { released: false }
    return (at: number) => {
      if (state.released) return
      state.released = true
      if (this.#entries.get(key) !== entry) return
      entry.holders -= 1
      entry.lastActivityAt = at
    }
  }

  /** Record activity on `key` without holding it. */
  touch(key: K, now: number) {
    this.#entry(key, now).lastActivityAt = now
  }

  holders(key: K) {
    return this.#entries.get(key)?.holders ?? 0
  }

  /** True when `key` is tracked, has no holder, and has been quiet for `idleMs` at `now`. */
  isIdle(key: K, idleMs: number, now: number) {
    const entry = this.#entries.get(key)
    if (!entry) return false
    return entry.holders === 0 && now - entry.lastActivityAt >= idleMs
  }

  idle(idleMs: number, now: number) {
    return [...this.#entries.keys()].filter((key) => this.isIdle(key, idleMs, now))
  }

  /** The resource behind `key` is gone. A key that still has holders stays tracked with a
   *  fresh clock, since those holders will recreate it lazily and release it later. */
  forget(key: K, now: number) {
    const entry = this.#entries.get(key)
    if (!entry) return
    if (entry.holders === 0) {
      this.#entries.delete(key)
      return
    }
    entry.lastActivityAt = now
  }

  keys() {
    return [...this.#entries.keys()]
  }

  #entry(key: K, now: number) {
    const existing = this.#entries.get(key)
    if (existing) return existing
    const created = { holders: 0, lastActivityAt: now }
    this.#entries.set(key, created)
    return created
  }
}

export * as IdleLease from "./idle-lease"

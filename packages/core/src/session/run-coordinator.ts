export * as SessionRunCoordinator from "./run-coordinator"

import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
  /**
   * Awaits the current execution's settlement, or returns immediately if idle.
   * Unlike `run`, never starts a new drain — safe to call after a `wake` whose
   * caller only wants to know when that admission's work has settled.
   */
  readonly join: (key: Key) => Effect.Effect<void, E>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void, never>
  pendingWake: boolean
  stopping: boolean
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
  /** Runs when a key becomes active; coalesced successor drains do not repeat it. */
  readonly onActive?: (key: Key) => Effect.Effect<void>
  /** Runs when a key's execution settles with no successor pending. */
  readonly onIdle?: (key: Key) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    // onIdle runs after its key leaves `active`, so a new execution can start while it is still in
    // flight; that execution's onActive waits for it so observers never see busy before idle.
    const idling = new Map<Key, Deferred.Deferred<void>>()
    // Mirrors the Deferred of whatever entry was most recently created for a key, independent of
    // `active`'s deletion on settle. A completed Deferred is cheap to re-await, so `join` can
    // answer "what did the last admission for this key settle with" even when it raced the
    // drain finishing (e.g. a drain with no async boundary can settle, and be deleted from
    // `active`, before the caller's next `join` call gets a scheduling turn).
    const lastDone = new Map<Key, Deferred.Deferred<void, E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      stopping: false,
    })

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(successor ? Effect.void : announce(key)),
          Effect.andThen(Effect.suspend(() => options.drain(key, force))),
          Effect.onExit((exit) => settle(key, entry, exit)),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    // Observers cannot fail or block coordination; a broken hook is logged and execution continues.
    const runHook = (hook: ((key: Key) => Effect.Effect<void>) | undefined, key: Key) =>
      hook
        ? Effect.suspend(() => hook(key)).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              (cause) => Effect.logError("Session run lifecycle hook failed", cause),
            ),
          )
        : Effect.void

    const announce = (key: Key) =>
      Effect.suspend(() => {
        const previous = idling.get(key)
        return (previous ? Deferred.await(previous) : Effect.void).pipe(Effect.andThen(runHook(options.onActive, key)))
      })

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) =>
      Effect.suspend(() => {
        if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
          entry.pendingWake = false
          start(key, entry, false, true)
          return Effect.void
        }

        if (entry.pendingWake) {
          const successor = makeEntry()
          active.set(key, successor)
          lastDone.set(key, successor.done)
          start(key, successor, false, true)
          Deferred.doneUnsafe(entry.done, exit)
          return Effect.void
        }

        active.delete(key)
        const idled = Deferred.makeUnsafe<void>()
        idling.set(key, idled)
        // Joiners resume only after onIdle, so a settled `run` or `join` has already been reported idle.
        return runHook(options.onIdle, key).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (idling.get(key) === idled) idling.delete(key)
              Deferred.doneUnsafe(idled, Effect.void)
              Deferred.doneUnsafe(entry.done, exit)
            }),
          ),
        )
      })

    const activate = (key: Key, force: boolean) => {
      const entry = makeEntry()
      active.set(key, entry)
      lastDone.set(key, entry.done)
      start(key, entry, force)
      return entry
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        return restore(Deferred.await(activate(key, true).done))
      })

    const wake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          return
        }
        activate(key, false)
      })

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    const join = (key: Key): Effect.Effect<void, E> =>
      Effect.suspend(() => {
        const deferred = lastDone.get(key)
        if (deferred === undefined) return Effect.void
        return Deferred.await(deferred)
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, interrupt, join }
  })

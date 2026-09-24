import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode, Node } from "@opencode-ai/core/effect/app-node"
import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { IdleLease } from "@opencode-ai/core/util/idle-lease"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Clock, Context, Deferred, Duration, Effect, Exit, Layer, Schedule, Scope } from "effect"
import { type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
}

export interface Interface {
  /** Loads (or returns the cached) instance. Counts as activity but holds no lease, so an
   *  idle sweep may dispose it once the caller stops using it. */
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  /** Loads the instance and holds a lease on it until the current scope closes. */
  readonly acquire: (input: LoadInput) => Effect.Effect<InstanceContext, never, Scope.Scope>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeDirectory: (directory: string) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  /** Runs `effect` against the instance, holding a lease on it for the duration. */
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

// Bounds how long an instance can outlive its idle window before the sweep notices.
const MAX_SWEEP_INTERVAL_MS = 60_000

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
}

type Requirements = Project.Service | InstanceBootstrap.Service | RuntimeFlags.Service

const layer: Layer.Layer<Service, never, Requirements> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const flags = yield* RuntimeFlags.Service
    const scope = yield* Scope.Scope
    const cache = new Map<string, Entry>()
    // Keyed by resolved directory. Holders are live users (requests, streams, detached
    // prompts); the idle clock only runs once the last one releases.
    const leases = new IdleLease.Tracker<string>()

    const forgetLease = (directory: string) =>
      Effect.map(Clock.currentTimeMillis, (now) => leases.forget(directory, now))

    const takeLease = (input: LoadInput) =>
      Effect.map(Clock.currentTimeMillis, (now) => leases.acquire(FSUtil.resolve(input.directory), now))
    const returnLease = (release: (now: number) => void) => Effect.map(Clock.currentTimeMillis, release)

    const boot = (input: LoadInput & { directory: string }) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree
            ? {
                directory: input.directory,
                worktree: input.worktree,
                project: input.project,
              }
            : yield* project.fromDirectory(input.directory).pipe(
                Effect.map((result) => ({
                  directory: input.directory,
                  worktree: result.sandbox,
                  project: result.project,
                })),
              )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directory: string, entry: Entry) =>
      Effect.gen(function* () {
        if (cache.get(directory) !== entry) return false
        cache.delete(directory)
        yield* forgetLease(directory)
        return true
      })

    const completeLoad = (directory: string, input: LoadInput, entry: Entry) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) yield* removeEntry(directory, entry)
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("disposing instance", { directory: ctx.directory })
      yield* Effect.promise(() => runDisposers(ctx.directory))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const disposeEntry = Effect.fnUntraced(function* (directory: string, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directory) !== entry) return false
      yield* disposeContext(ctx)
      if (cache.get(directory) !== entry) return false
      cache.delete(directory)
      yield* forgetLease(directory)
      return true
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          leases.touch(directory, yield* Clock.currentTimeMillis)
          const existing = cache.get(directory)
          if (existing) return yield* restore(Deferred.await(existing.deferred))

          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("creating instance", { directory: directory })
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = FSUtil.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directory)
          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directory, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("reloading instance", { directory: directory })
            if (previous) {
              yield* Deferred.await(previous.deferred).pipe(Effect.ignore)
              yield* Effect.promise(() => runDisposers(directory))
              yield* emitDisposed({ directory, project: input.project?.id })
            }
            yield* completeLoad(directory, input, entry)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directory)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directory, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directory, entry, ctx).pipe(Effect.asVoid)
    })

    const disposeDirectory = Effect.fn("InstanceStore.disposeDirectory")(function* (input: string) {
      const directory = FSUtil.resolve(input)
      const entry = cache.get(directory)
      if (!entry) return
      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry).pipe(Effect.asVoid)
      yield* disposeEntry(directory, entry, exit.value).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed", { key: item[0], cause: exit.cause })
              yield* removeEntry(item[0], item[1])
              return
            }
            yield* disposeEntry(item[0], item[1], exit.value)
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    // The lease is taken before loading so a sweep can never evict an instance between
    // its load completing and its first holder registering.
    const acquire = (input: LoadInput) =>
      Effect.acquireRelease(takeLease(input), returnLease).pipe(Effect.andThen(load(input)))

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        takeLease(input),
        () => load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx)))),
        returnLease,
      )

    const evictIdle = Effect.fn("InstanceStore.evictIdle")(function* (idleMs: number) {
      const now = yield* Clock.currentTimeMillis
      yield* Effect.forEach(
        leases.idle(idleMs, now),
        Effect.fnUntraced(function* (directory) {
          const entry = cache.get(directory)
          if (!entry) return yield* forgetLease(directory)
          const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
          if (Exit.isFailure(exit)) return yield* removeEntry(directory, entry)
          // Re-read right before disposing: a holder may have arrived while the load settled.
          if (!leases.isIdle(directory, idleMs, yield* Clock.currentTimeMillis)) return
          yield* Effect.logInfo("evicting idle instance", { directory })
          yield* disposeEntry(directory, entry, exit.value)
        }),
        { discard: true },
      )
    })

    if (flags.instanceIdleTimeoutMs !== undefined) {
      const idleMs = flags.instanceIdleTimeoutMs
      const interval = Duration.millis(Math.min(idleMs, MAX_SWEEP_INTERVAL_MS))
      yield* evictIdle(idleMs).pipe(
        Effect.catchCause((cause) => Effect.logWarning("instance idle sweep failed", { cause })),
        Effect.repeat(Schedule.spaced(interval)),
        Effect.delay(interval),
        Effect.forkIn(scope),
      )
    }

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      acquire,
      reload,
      dispose,
      disposeDirectory,
      disposeAll,
      provide,
    })
  }),
)

export const bootstrapNode = LayerNode.unbound(InstanceBootstrap.Service, Node.tags.values.global)

export const node = makeGlobalNode({
  service: Service,
  layer: layer,
  deps: [Project.node, bootstrapNode, RuntimeFlags.node],
})

export * as InstanceStore from "./instance-store"

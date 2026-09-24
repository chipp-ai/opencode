import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const IDLE_MS = 200

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(CrossSpawnSpawner.node),
    LayerNode.compile(InstanceStore.node, [
      [InstanceStore.bootstrapNode, noopBootstrap],
      [RuntimeFlags.node, RuntimeFlags.layer({ instanceIdleTimeoutMs: IDLE_MS })],
    ]),
  ),
)

// Per-directory state whose finalizer records disposal, so a test can observe eviction
// through the same InstanceState mechanism real services use.
const tracked = Effect.gen(function* () {
  const disposed: string[] = []
  const state = yield* InstanceState.make((ctx) =>
    Effect.acquireRelease(Effect.succeed(ctx.directory), (directory) => Effect.sync(() => disposed.push(directory))),
  )
  return { state, disposed }
})

const sleep = (ms: number) => Effect.promise(() => Bun.sleep(ms))

describe("InstanceStore idle eviction", () => {
  it.live("evicts an instance once its last holder releases and the idle window passes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const probe = yield* tracked

      yield* store.provide({ directory: dir }, InstanceState.get(probe.state))
      expect(probe.disposed).toEqual([])

      yield* sleep(IDLE_MS * 3)
      expect(probe.disposed).toEqual([dir])
    }),
  )

  it.live("counts concurrent holders and only evicts after the last one releases", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const probe = yield* tracked
      const releaseA = yield* Deferred.make<void>()
      const releaseB = yield* Deferred.make<void>()

      const a = yield* store
        .provide({ directory: dir }, InstanceState.get(probe.state).pipe(Effect.andThen(Deferred.await(releaseA))))
        .pipe(Effect.forkScoped)
      const b = yield* store
        .provide({ directory: dir }, InstanceState.get(probe.state).pipe(Effect.andThen(Deferred.await(releaseB))))
        .pipe(Effect.forkScoped)

      yield* sleep(IDLE_MS * 3)
      expect(probe.disposed).toEqual([])

      yield* Deferred.succeed(releaseA, undefined)
      yield* Fiber.join(a)
      yield* sleep(IDLE_MS * 3)
      expect(probe.disposed).toEqual([])

      yield* Deferred.succeed(releaseB, undefined)
      yield* Fiber.join(b)
      yield* sleep(IDLE_MS * 3)
      expect(probe.disposed).toEqual([dir])
    }),
  )

  it.live("a scoped acquire holds the instance until its scope closes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const probe = yield* tracked

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* store.acquire({ directory: dir })
          yield* store.provide({ directory: dir }, InstanceState.get(probe.state))
          yield* sleep(IDLE_MS * 3)
          expect(probe.disposed).toEqual([])
        }),
      )

      yield* sleep(IDLE_MS * 3)
      expect(probe.disposed).toEqual([dir])
    }),
  )

  it.live("activity through load restarts the idle clock", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const probe = yield* tracked

      yield* store.provide({ directory: dir }, InstanceState.get(probe.state))
      yield* Effect.forEach(
        Array.from({ length: 6 }),
        () => sleep(IDLE_MS / 2).pipe(Effect.andThen(store.load({ directory: dir }))),
        {
          discard: true,
        },
      )
      expect(probe.disposed).toEqual([])
    }),
  )

  it.live("an evicted instance is recreated lazily on next use", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const probe = yield* tracked

      const first = yield* store.load({ directory: dir })
      yield* store.provide({ directory: dir }, InstanceState.get(probe.state))
      yield* sleep(IDLE_MS * 3)
      expect(probe.disposed).toEqual([dir])

      const second = yield* store.load({ directory: dir })
      expect(second).not.toBe(first)
      expect(yield* store.provide({ directory: dir }, InstanceState.get(probe.state))).toBe(dir)
    }),
  )

  it.live("directories are tracked independently", () =>
    Effect.gen(function* () {
      const busy = yield* tmpdirScoped()
      const idle = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const probe = yield* tracked
      const release = yield* Deferred.make<void>()

      const holder = yield* store
        .provide({ directory: busy }, InstanceState.get(probe.state).pipe(Effect.andThen(Deferred.await(release))))
        .pipe(Effect.forkScoped)
      yield* store.provide({ directory: idle }, InstanceState.get(probe.state))

      yield* sleep(IDLE_MS * 3)
      expect(probe.disposed).toEqual([idle])

      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(holder)
    }),
  )
})

describe("InstanceStore without an idle timeout", () => {
  const plain = testEffect(
    Layer.mergeAll(
      LayerNode.compile(CrossSpawnSpawner.node),
      LayerNode.compile(InstanceStore.node, [
        [InstanceStore.bootstrapNode, noopBootstrap],
        [RuntimeFlags.node, RuntimeFlags.layer({})],
      ]),
    ),
  )

  plain.live("never evicts", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const probe = yield* tracked
      yield* store.provide({ directory: dir }, InstanceState.get(probe.state))
      yield* sleep(IDLE_MS * 3)
      expect(probe.disposed).toEqual([])
    }),
  )
})

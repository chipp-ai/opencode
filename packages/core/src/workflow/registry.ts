export * as WorkflowRegistry from "./registry"

import { Context, Effect, Layer } from "effect"
import type { Workflow } from "@opencode-ai/schema/workflow"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { WorkflowDiscovery } from "./discovery"
import { WorkflowRunStore } from "./store"

/**
 * Closes over Database.Service/FSUtil.Service at layer-build time, matching every other global
 * domain service in this codebase (see Credential.node) -- so a caller (the HTTP handler) only
 * ever depends on this one Service, never on Database.Service/FSUtil.Service directly. Handlers
 * that skip this and `yield* Database.Service` themselves leak it into the HttpApi's own handler
 * type graph in a way `Layer.provide` doesn't clean up, breaking every consumer of the compiled
 * Api (discovered the hard way: it broke `packages/cli`'s daemon typecheck, several packages away
 * from this file).
 */
export interface Interface {
  readonly list: (directory: string) => Effect.Effect<{ workflows: Workflow.Info[]; errors: Workflow.LintError[] }>
  readonly find: (directory: string, id: string) => Effect.Effect<Workflow.Info | undefined>
  readonly readBody: (path: string) => Effect.Effect<string>
  readonly getRun: (id: string) => Effect.Effect<WorkflowRunStore.Run | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const fs = yield* FSUtil.Service
    const withFs = <A>(effect: Effect.Effect<A, never, FSUtil.Service>) => effect.pipe(Effect.provideService(FSUtil.Service, fs))
    return Service.of({
      list: (directory) => withFs(WorkflowDiscovery.list(directory)),
      find: (directory, id) => withFs(WorkflowDiscovery.find(directory, id)),
      readBody: (path) => withFs(WorkflowDiscovery.readBody(path)),
      getRun: (id) => WorkflowRunStore.get(db, id),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, FSUtil.node] })

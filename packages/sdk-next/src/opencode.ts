import { OpenCode } from "@opencode-ai/client/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { createEmbeddedRoutes } from "@opencode-ai/server/routes"
import { Context, Effect, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"

export const create = Effect.fn("OpenCode.create")(function* () {
  const scope = yield* Scope.Scope
  const memoMap = yield* Layer.makeMemoMap
  const context = yield* Layer.buildWithMemoMap(
    AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, PermissionSaved.node])),
    memoMap,
    scope,
  )
  const tools = Context.get(context, ApplicationTools.Service)
  const permissions = Context.get(context, PermissionSaved.Service)
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        createEmbeddedRoutes().pipe(
          HttpRouter.provideRequest(Layer.succeed(PermissionSaved.Service, permissions)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true, memoMap },
      ),
    ),
    (web) => Effect.promise(web.dispose),
  )
  // toWebHandler's `handler` gains a mandatory second `Context.Context<HR>` parameter whenever HR
  // (the layer's still-unresolved middleware "Requires" markers) isn't `never` -- even when, as
  // here, everything is already closed at the value level via createEmbeddedRoutes's own
  // Layer.provide chain. `Layer.provide` closes ITS OWN caller's requirement, but never folds the
  // provided layer's output back into what toWebHandler itself sees as resolved, so this stays
  // non-`never` once a handler (WorkflowHandler) directly depends on a service (WorkflowRegistry,
  // transitively Database/SessionV2) no other handler happened to need before. The context really
  // is empty at this call site -- createEmbeddedRoutes/HttpRouter.provideRequest already supplied
  // everything real per-request -- so an empty Context.Context<HR> is a true, not a papered-over,
  // second argument.
  const fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      web.handler(new Request(input, init), Context.empty() as never),
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  const client = yield* OpenCode.make({ baseUrl: "http://opencode.local" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  )
  return {
    ...client,
    tools: { register: tools.register },
  }
})

export type Interface = Effect.Success<ReturnType<typeof create>>

export class Service extends Context.Service<Service, Interface>()("@opencode-ai/sdk-next/OpenCode") {}

export const layer = Layer.effect(Service, create())

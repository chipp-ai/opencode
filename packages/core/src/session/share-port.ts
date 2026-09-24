export * as SessionSharePort from "./share-port"

import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"
import type { SessionSchema } from "./schema"

/**
 * Publishing a Session to the hosted share service. The wire protocol, account/org auth, and the
 * cached `session_share` row belong to the app layer (`packages/opencode`'s `ShareNext`), which core
 * cannot depend on, so `SessionV2` depends on this unbound port and the composition root supplies the
 * real implementation -- the same shape as `./dispatch-port.ts`.
 *
 * Error channels are untyped because every failure (sharing disabled, no account token, backend
 * errors) originates in the app layer and is only ever surfaced as a message.
 */
export interface Interface {
  readonly share: (sessionID: SessionSchema.ID) => Effect.Effect<{ readonly url: string }, unknown>
  readonly unshare: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSharePort") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

/**
 * Auto-injected by `../effect/app-node-builder.ts` when no real implementation is supplied, so builds
 * without the app layer (the standalone server, tests) still construct `SessionV2`. Sharing then
 * fails with a clear message instead of the build failing on an unbound node.
 */
export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    share: () => Effect.fail(new Error("Session sharing is not available in this server")),
    unshare: () => Effect.fail(new Error("Session sharing is not available in this server")),
  }),
)

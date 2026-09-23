export * as SessionDispatchPort from "./dispatch-port"

import { Context, Effect, Layer } from "effect"
import type { AgentV2 } from "../agent"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"
import type { Location } from "../location"
import type { ModelV2 } from "../model"
import type { PromptInput } from "@opencode-ai/schema/prompt-input"
import type { SessionInput } from "./input"
import type { SessionSchema } from "./schema"

/**
 * A narrow, structural view of `SessionV2.Interface` -- just the methods a one-shot subagent
 * dispatch needs (`create`, `prompt`, `wait`, `interrupt`, `get`) -- deliberately declared
 * independently of `../session` rather than importing `SessionV2.Interface` directly.
 *
 * `SessionV2.Service` depends, through `../location-service-map`, on the same location/tool
 * bootstrap (`../location-services`) that Location-scoped built-in tools compose into. A tool
 * importing `../session` directly would close a real dependency cycle, not just a TypeScript
 * one (confirmed by reading `../effect/layer-node.ts`'s `compile()`). This port is the same
 * fix `../location-service-map.ts` already applies in the opposite direction (`SessionV2.node`
 * depends on `LocationServiceMap.node`, an unbound placeholder, rather than `../location-services`
 * directly): declare a small interface with no cyclic imports, expose it as an unbound node, and
 * let the composition root (wherever `SessionV2.node`'s real layer is built) supply the real
 * `SessionV2.Service` instance as this port's implementation.
 *
 * Error channels are deliberately untyped (`unknown`) rather than reusing `SessionV2.NotFoundError`/
 * `SessionRunner.RunError` -- both are defined inside `../session`/its runner, which would
 * reintroduce the exact same cycle one hop further out. Every real caller (`../tool/task.ts`) maps
 * dispatch failures through a generic `ToolFailure`, so losing the specific tagged-error identity
 * here costs nothing in practice.
 */
export interface Interface {
  readonly create: (input: {
    readonly id?: SessionSchema.ID
    readonly agent?: AgentV2.ID
    readonly model?: ModelV2.Ref
    readonly location: Location.Ref
    readonly parentID?: SessionSchema.ID
  }) => Effect.Effect<SessionSchema.Info, unknown>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, unknown>
  readonly prompt: (input: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: PromptInput.Prompt
  }) => Effect.Effect<SessionInput.Admitted, unknown>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, unknown>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionDispatchPort") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

/**
 * Auto-injected by `../effect/app-node-builder.ts` (mirroring how it auto-supplies
 * `LocationServiceMap.node`) whenever this node is left unbound with no explicit replacement.
 * `../tool/task.ts`'s registration layer unconditionally yields `SessionDispatchPort.Service` as
 * soon as the location boots -- not only when the `task` tool is actually called -- so every
 * caller of the real location bootstrap needs *some* implementation to exist, even one that never
 * dispatches anything. Every method dies with a clear message if actually invoked; real dispatch
 * only happens where the composition root supplies the genuine `SessionV2`-backed implementation
 * (`packages/opencode/src/server/routes/instance/httpapi/server.ts`).
 */
const unavailable = (method: string) => Effect.die(`SessionDispatchPort.${method}: no real implementation was supplied for this build`)
export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    create: () => unavailable("create"),
    get: () => unavailable("get"),
    prompt: () => unavailable("prompt"),
    wait: () => unavailable("wait"),
    interrupt: () => unavailable("interrupt"),
  }),
)

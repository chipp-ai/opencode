import { Context, Effect } from "effect"

export interface Interface {
  readonly closeAll: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ListenerServer") {}

export * as ListenerServer from "./listener-server"

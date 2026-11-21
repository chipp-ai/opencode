import type { Plugin } from "@opencode-ai/plugin"
import type { EventV2 } from "@opencode-ai/core/event"
import type { RouteExtension } from "@/server/routes/instance/httpapi/extension"

// Build-time extension point for a downstream product that compiles its own entrypoint together with
// this package: the entrypoint registers its contribution, then imports the CLI. `Server.listen` and the
// plugin service read what was registered, so `opencode serve` runs with it and no flag or config enables it.
export type Contribution = {
  readonly name: string
  readonly routeExtensions?: ReadonlyArray<RouteExtension.RouteExtension>
  /** Same contract as `EventV2.LayerOptions["persist"]`; at most one contribution may supply it. */
  readonly persist?: EventV2.LayerOptions["persist"]
  /** Same contract as `EventV2.Deliver`; at most one contribution may supply it. */
  readonly deliver?: EventV2.Deliver
  /** Server plugins loaded for every instance after the internal plugins. Unlike config plugins, a failed init fails the instance. */
  readonly plugins?: ReadonlyArray<Plugin>
}

const contributions: Contribution[] = []

export function register(contribution: Contribution) {
  if (contribution.persist && contributions.some((item) => item.persist))
    throw new Error(`embed ${contribution.name}: another contribution already supplies persist`)
  if (contribution.deliver && contributions.some((item) => item.deliver))
    throw new Error(`embed ${contribution.name}: another contribution already supplies deliver`)
  contributions.push(contribution)
}

export function list(): ReadonlyArray<Contribution> {
  return contributions
}

export function routeExtensions() {
  return contributions.flatMap((item) => item.routeExtensions ?? [])
}

export function persist() {
  return contributions.find((item) => item.persist)?.persist
}

export function deliver() {
  return contributions.find((item) => item.deliver)?.deliver
}

export function plugins() {
  return contributions.flatMap((item) => item.plugins ?? [])
}

export * as Embed from "./embed"

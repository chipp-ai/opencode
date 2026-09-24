import { buildLocationServiceMap } from "../location-services"
import { LocationServiceMap } from "../location-service-map"
import { SessionDispatchPort } from "../session/dispatch-port"
import { SessionSharePort } from "../session/share-port"
import { LayerNode } from "./layer-node"
import { makeGlobalNode } from "./app-node"

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  let allReplacements = replacements

  // Only build the location service map if it's actually needed. `buildLocationServiceMap` itself
  // supplies a safe `SessionDispatchPort` default when the caller doesn't provide one (see its own
  // comment) -- that's the single choke point every caller goes through, including direct callers
  // of `buildLocationServiceMap` that never go through this function at all.
  if (LayerNode.hasUnbound(root, LocationServiceMap.node) && !hasReplacement(replacements, LocationServiceMap.node)) {
    const locationMap = buildLocationServiceMap(replacements)
    const locationMapNode = makeGlobalNode({ service: LocationServiceMap.Service, layer: locationMap, deps: [] })
    allReplacements = replacements.concat([[LocationServiceMap.node, locationMapNode]])
  }

  // Covers callers that build a tool/location node directly (e.g. `TaskTool.node` in isolation)
  // without ever routing through `LocationServiceMap.node` at all.
  if (LayerNode.hasUnbound(root, SessionDispatchPort.node) && !hasReplacement(allReplacements, SessionDispatchPort.node)) {
    allReplacements = allReplacements.concat([[SessionDispatchPort.node, SessionDispatchPort.unavailableLayer]])
  }

  if (LayerNode.hasUnbound(root, SessionSharePort.node) && !hasReplacement(allReplacements, SessionSharePort.node)) {
    allReplacements = allReplacements.concat([[SessionSharePort.node, SessionSharePort.unavailableLayer]])
  }

  return LayerNode.compile(root, allReplacements)
}

function hasReplacement(replacements: LayerNode.Replacements, node: LayerNode.Node<unknown, unknown, any>) {
  return replacements.some(([source]) => source.name === node.name)
}

export * as AppNodeBuilder from "./app-node-builder"

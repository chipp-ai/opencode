export * as CommandV2 from "./command"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Types } from "effect"
import { Command } from "@opencode-ai/schema/command"
import { State } from "./state"

export const Info = Command.Info
export type Info = Command.Info

export type Data = {
  commands: Map<string, Types.DeepMutable<Info>>
}

export type Draft = {
  list: () => readonly Info[]
  get: (name: string) => Info | undefined
  update: (name: string, update: (command: Types.DeepMutable<Info>) => void) => void
  remove: (name: string) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Command") {}

const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const state = State.create<Data, Draft>({
      initial: () => ({ commands: new Map() }),
      draft: (draft) => ({
        list: () => Array.from(draft.commands.values()) as Info[],
        get: (name) => draft.commands.get(name),
        update: (name, update) => {
          const current = draft.commands.get(name) ?? ({ name, template: "" } as Types.DeepMutable<Info>)
          if (!draft.commands.has(name)) draft.commands.set(name, current)
          update(current)
          current.name = name
        },
        remove: (name) => {
          draft.commands.delete(name)
        },
      }),
    })

    return Service.of({
      reload: state.reload,
      transform: state.transform,
      get: Effect.fn("CommandV2.get")(function* (name) {
        return state.get().commands.get(name)
      }),
      list: Effect.fn("CommandV2.list")(function* () {
        return Array.from(state.get().commands.values())
      }),
    })
  }),
)

/** Inline `` !`command` `` markers, expanded with shell output after argument substitution. */
export const SHELL_PATTERN = /!`([^`]+)`/g

const ARGUMENT_PATTERN = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const PLACEHOLDER_PATTERN = /\$(\d+)/g
const QUOTE_PATTERN = /^["']|["']$/g

/**
 * Substitutes `$1`, `$2`, ... and `$ARGUMENTS` into a command template, matching V1. The highest positional
 * placeholder swallows every remaining argument. A template without placeholders gets the raw arguments appended.
 */
export function render(template: string, args: string) {
  const parsed = (args.match(ARGUMENT_PATTERN) ?? []).map((arg) => arg.replace(QUOTE_PATTERN, ""))
  const placeholders = template.match(PLACEHOLDER_PATTERN) ?? []
  const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
  const text = template
    .replaceAll(PLACEHOLDER_PATTERN, (_, index) => {
      const position = Number(index)
      if (position > parsed.length) return ""
      if (position === last) return parsed.slice(position - 1).join(" ")
      return parsed[position - 1]
    })
    // A replacer function, so `$&`-style sequences typed in the arguments stay literal.
    .replaceAll("$ARGUMENTS", () => args)
  if (placeholders.length === 0 && !template.includes("$ARGUMENTS") && args.trim()) return text + "\n\n" + args
  return text
}

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [] })

import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, Show } from "solid-js"
import { useData } from "../../context/data"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const data = useData()
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  // V2 spend lives on the server-side rollup rather than legacy session rows, which the plugin API does not expose.
  const v2 = createMemo(() => (data.session.message.list(props.session_id)?.length ?? 0) > 0)
  createEffect(() => {
    if (!v2()) return
    void data.session.cost.refresh(props.session_id).catch(() => {})
  })
  const rollup = createMemo(() => (v2() ? data.session.cost.get(props.session_id) : undefined))
  const cost = createMemo(() => {
    if (v2()) return rollup()?.cost ?? 0
    return session()?.cost ?? 0
  })
  const subagents = createMemo(() => {
    if (v2()) return rollup()?.subagents.cost ?? 0
    const visited = new Set<string>([props.session_id])
    const walk = (sessionID: string): number =>
      props.api.state.session
        .children(sessionID)
        .filter((child) => !visited.has(child.id))
        .reduce((sum, child) => {
          visited.add(child.id)
          return sum + (child.cost ?? 0) + walk(child.id)
        }, 0)
    return walk(props.session_id)
  })

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>{money.format(cost() + subagents())} spent</text>
      <Show when={subagents() > 0}>
        <text fg={theme().textMuted}>(+{money.format(subagents())} subagents)</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin

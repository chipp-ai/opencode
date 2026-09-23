import type { InputRenderable } from "@opentui/core"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useTuiConfig } from "../../config"
import { useTheme } from "../../context/theme"
import { useBindings, useCommandShortcut, useOpencodeModeStack } from "../../keymap"

export const SESSION_FIND_MODE = "session.find"

export const sessionFindBindingCommands = ["session.find.next", "session.find.previous", "session.find.close"] as const

export function SessionFindBar(props: {
  query: string
  index: number
  count: number
  onQuery: (query: string) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}) {
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const modeStack = useOpencodeModeStack()
  const previousShortcut = useCommandShortcut("session.find.previous")
  const nextShortcut = useCommandShortcut("session.find.next")
  const closeShortcut = useCommandShortcut("session.find.close")
  const [inputTarget, setInputTarget] = createSignal<InputRenderable>()

  // Pushing a mode disables base-mode bindings (e.g. escape interrupting the
  // session) while the find bar owns the keyboard.
  onMount(() => onCleanup(modeStack.push(SESSION_FIND_MODE)))

  useBindings(() => ({
    mode: SESSION_FIND_MODE,
    target: inputTarget,
    enabled: inputTarget() !== undefined,
    // Find navigation must win over the input's own return/up/down handling.
    priority: 1,
    commands: [
      { name: "session.find.next", title: "Next match", category: "Session", run: props.onNext },
      { name: "session.find.previous", title: "Previous match", category: "Session", run: props.onPrevious },
      { name: "session.find.close", title: "Close find", category: "Session", run: props.onClose },
    ],
    bindings: tuiConfig.keybinds.gather("session.find", sessionFindBindingCommands),
  }))

  return (
    <box flexShrink={0} flexDirection="row" gap={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
      <text fg={theme.warning} flexShrink={0}>
        Find
      </text>
      <input
        flexGrow={1}
        value={props.query}
        onInput={props.onQuery}
        placeholder="Search this session"
        placeholderColor={theme.textMuted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        focusedBackgroundColor={theme.backgroundPanel}
        cursorColor={theme.primary}
        cursorStyle={tuiConfig.cursor}
        ref={(r: InputRenderable) => {
          r.traits = { status: "FIND" }
          setInputTarget(r)
          queueMicrotask(() => {
            if (r.isDestroyed) return
            r.focus()
            r.gotoLineEnd()
          })
        }}
      />
      <text fg={props.count ? theme.text : theme.textMuted} flexShrink={0}>
        {props.query.trim() ? `${props.count ? props.index + 1 : 0}/${props.count}` : ""}
      </text>
      <text fg={theme.textMuted} flexShrink={0} paddingRight={1}>
        <Show when={previousShortcut()}>
          <span style={{ fg: theme.text }}>{previousShortcut()}</span> older{" "}
        </Show>
        <Show when={nextShortcut()}>
          <span style={{ fg: theme.text }}>{nextShortcut()}</span> newer{" "}
        </Show>
        <Show when={closeShortcut()}>
          <span style={{ fg: theme.text }}>{closeShortcut()}</span> close
        </Show>
      </text>
    </box>
  )
}

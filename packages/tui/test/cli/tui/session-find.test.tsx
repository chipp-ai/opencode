/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup, Show } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import type { TuiKeybind } from "../../../src/config/keybind"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountFind(input: { root: string; keybinds?: Partial<TuiKeybind.Keybinds> }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { SessionFindBar },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap, getOpencodeModeStack, useBindings, OPENCODE_BASE_MODE },
  ] = await Promise.all([
    import("../../../src/routes/session/find"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/keymap"),
  ])

  const events: string[] = []
  const [open, setOpen] = createSignal(true)
  const [query, setQuery] = createSignal("")
  const modes: string[] = []

  function BaseEscape() {
    // Stands in for base-mode escape handlers such as session interrupt.
    useBindings(() => ({
      mode: OPENCODE_BASE_MODE,
      bindings: [{ key: "escape", desc: "Interrupt", group: "Test", cmd: () => events.push("interrupt") }],
    }))
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ keybinds: input.keybinds, leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)
    const modeStack = getOpencodeModeStack(keymap)

    return (
      <TestTuiContexts directory={input.root} paths={{ home: input.root, state, worktree: input.root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <BaseEscape />
                <Show when={open()}>
                  <SessionFindBar
                    query={query()}
                    index={0}
                    count={3}
                    onQuery={(value) => {
                      setQuery(value)
                      modes.push(modeStack.current())
                    }}
                    onNext={() => events.push("next")}
                    onPrevious={() => events.push("previous")}
                    onClose={() => {
                      events.push("close")
                      setOpen(false)
                    }}
                  />
                </Show>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  return { app, events, query, modes, open }
}

test("find bar types a query, navigates matches, and closes without interrupting", async () => {
  await using tmp = await tmpdir()
  const find = await mountFind({ root: tmp.path })

  try {
    await wait(() => find.app.renderer.currentFocusedEditor instanceof InputRenderable)

    await find.app.mockInput.typeText("needle")
    expect(find.query()).toBe("needle")
    expect(find.modes.at(-1)).toBe("session.find")

    find.app.mockInput.pressEnter()
    find.app.mockInput.pressKey("ARROW_UP")
    find.app.mockInput.pressEnter({ shift: true })
    find.app.mockInput.pressKey("ARROW_DOWN")
    expect(find.events).toEqual(["next", "next", "previous", "previous"])

    await find.app.renderOnce()
    expect(find.app.captureCharFrame()).toContain("1/3")

    find.app.mockInput.pressEscape()
    expect(find.events).toEqual(["next", "next", "previous", "previous", "close"])
    expect(find.open()).toBe(false)
  } finally {
    find.app.renderer.destroy()
  }
})

test("find navigation keys can be rebound", async () => {
  await using tmp = await tmpdir()
  const find = await mountFind({
    root: tmp.path,
    keybinds: { session_find_next: "ctrl+g", session_find_previous: "ctrl+shift+g" },
  })

  try {
    await wait(() => find.app.renderer.currentFocusedEditor instanceof InputRenderable)
    find.app.mockInput.pressEnter()
    expect(find.events).toEqual([])

    find.app.mockInput.pressKey("g", { ctrl: true })
    find.app.mockInput.pressKey("g", { ctrl: true, shift: true })
    expect(find.events).toEqual(["next", "previous"])
  } finally {
    find.app.renderer.destroy()
  }
})

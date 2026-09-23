/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { promptOffsetWidth } from "../../src/prompt/display"
import { replaceVirtualExtmarkText, togglePastedText } from "../../src/prompt/part"

async function mountTextarea() {
  let input!: TextareaRenderable
  const app = await testRender(() => <textarea ref={(r: TextareaRenderable) => (input = r)} width={60} />, {
    width: 60,
    height: 10,
  })
  input.focus()
  const typeId = input.extmarks.registerType("prompt-part")
  return { app, input, typeId }
}

test("expands and collapses a pasted chip in place", async () => {
  const { app, input, typeId } = await mountTextarea()
  try {
    const marker = "[Pasted ~3 lines]"
    const text = "alpha\nbeta\ngamma"
    const trailing = "[Image 1]"
    input.insertText(`ab ${marker} cd ${trailing}`)
    const start = 3
    const id = input.extmarks.create({ start, end: start + marker.length, virtual: true, typeId })
    const imageStart = start + marker.length + 4
    const imageID = input.extmarks.create({
      start: imageStart,
      end: imageStart + trailing.length,
      virtual: true,
      typeId,
    })

    const mark = input.extmarks.get(id)!
    const expanded = togglePastedText({ text, source: { text: { value: marker, placeholder: marker } } })!
    const opened = replaceVirtualExtmarkText(input, mark, expanded.value)

    expect(input.plainText).toBe(`ab ${text} cd ${trailing}`)
    expect(input.extmarks.get(id)).toBeNull()
    expect(input.extmarks.get(opened.id)).toMatchObject({ start, end: start + promptOffsetWidth(text), typeId })
    // Later chips shift by the width delta.
    const delta = promptOffsetWidth(text) - marker.length
    expect(input.extmarks.get(imageID)).toMatchObject({ start: imageStart + delta, end: imageStart + delta + 9 })

    const collapsed = togglePastedText({ text, source: { text: expanded } })!
    const closed = replaceVirtualExtmarkText(input, input.extmarks.get(opened.id)!, collapsed.value)

    expect(input.plainText).toBe(`ab ${marker} cd ${trailing}`)
    expect(input.extmarks.get(closed.id)).toMatchObject({ start, end: start + marker.length, virtual: true })
    expect(input.extmarks.get(imageID)).toMatchObject({ start: imageStart, end: imageStart + trailing.length })
  } finally {
    app.renderer.destroy()
  }
})

test("a click on a chip leaves the cursor inside its extmark", async () => {
  const { app, input, typeId } = await mountTextarea()
  try {
    const marker = "[Pasted ~3 lines]"
    input.insertText(`ab ${marker} cd`)
    const id = input.extmarks.create({ start: 3, end: 3 + marker.length, virtual: true, typeId })
    await app.renderOnce()

    input.cursorOffset = 0
    await app.mockMouse.click(input.x + 8, input.y)
    expect(input.extmarks.getAtOffset(input.cursorOffset).map((mark) => mark.id)).toEqual([id])

    await app.mockMouse.click(input.x + 1, input.y)
    expect(input.extmarks.getAtOffset(input.cursorOffset)).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

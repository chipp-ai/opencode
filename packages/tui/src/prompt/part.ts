import type { Extmark, TextareaRenderable } from "@opentui/core"
import { displaySlice, promptOffsetWidth } from "./display"

export function stripPromptPartIDs<Part extends { id: string; messageID: string; sessionID: string }>(part: Part) {
  const { id: _id, messageID: _messageID, sessionID: _sessionID, ...rest } = part
  return rest
}

export function expandPastedTextPlaceholders(text: string, parts: readonly unknown[]) {
  return parts.reduce<string>((result, part) => {
    if (!isPastedTextPart(part)) return result
    return result.replace(part.source.text.value, () => part.text)
  }, text)
}

function isPastedTextPart(part: unknown): part is { type: "text"; text: string; source: { text: { value: string } } } {
  if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return false
  if (!("text" in part) || typeof part.text !== "string" || !("source" in part)) return false
  const source = part.source
  if (!source || typeof source !== "object" || !("text" in source)) return false
  const text = source.text
  return Boolean(text && typeof text === "object" && "value" in text && typeof text.value === "string")
}

export function expandTrackedPastedText(text: string, ranges: { start: number; end: number; text: string }[]) {
  return ranges
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((result, part) => displaySlice(result, 0, part.start) + part.text + displaySlice(result, part.end), text)
}

// A pasted-text part is expanded when its visible value is the full pasted text. The collapsed
// placeholder is remembered so it can be restored; entries saved before `placeholder` existed
// are always collapsed at that point, so their current value is the placeholder.
export function togglePastedText(part: { text: string; source: { text: { value: string; placeholder?: string } } }) {
  const expanded = part.source.text.value === part.text
  const placeholder = part.source.text.placeholder ?? (expanded ? undefined : part.source.text.value)
  if (placeholder === undefined) return
  return { value: expanded ? placeholder : part.text, placeholder }
}

// Replaces the text covered by a virtual extmark and recreates the extmark over the new text,
// keeping its style and type so it still behaves as a single cursor unit.
export function replaceVirtualExtmarkText(input: TextareaRenderable, mark: Extmark, text: string) {
  input.extmarks.delete(mark.id)
  input.setSelection(mark.start, mark.end)
  input.insertText(text)
  const end = mark.start + promptOffsetWidth(text)
  return {
    start: mark.start,
    end,
    id: input.extmarks.create({ start: mark.start, end, virtual: true, styleId: mark.styleId, typeId: mark.typeId }),
  }
}

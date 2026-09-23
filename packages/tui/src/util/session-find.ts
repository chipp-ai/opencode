import type { Message, Part } from "@opencode-ai/sdk/v2"
import { errorMessage } from "./error"

export type SessionFindMatch = {
  messageID: string
  // Renderable id in the session scrollbox that the match scrolls to.
  target: string
}

// Searchable text mirrors what the session view renders: user/assistant text
// and reasoning parts, tool call input values, and assistant error rows.
// Tool outputs are excluded because most tools render them collapsed or not at all.
export function partSearchText(part: Part) {
  if (part.type === "text") return part.synthetic ? "" : part.text
  if (part.type === "reasoning") return part.text
  if (part.type === "tool") return stringLeaves(part.state.input).join("\n")
  return ""
}

export function findMatches(input: { messages: Message[]; parts: (messageID: string) => Part[]; query: string }) {
  const needle = input.query.trim().toLowerCase()
  if (!needle) return []
  const hit = (text: string) => text.toLowerCase().includes(needle)
  return input.messages.flatMap((message): SessionFindMatch[] => {
    const parts = input.parts(message.id)
    if (message.role === "user") {
      const text = parts
        .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
        .join("\n")
      return hit(text) ? [{ messageID: message.id, target: message.id }] : []
    }
    const matches = parts
      .filter((part) => hit(partSearchText(part)))
      .map((part) => ({ messageID: message.id, target: part.id }))
    const error = message.error && message.error.name !== "MessageAbortedError" ? errorMessage(message.error) : ""
    if (!hit(error)) return matches
    return [...matches, { messageID: message.id, target: errorTarget(message.id) }]
  })
}

export function errorTarget(messageID: string) {
  return `${messageID}:error`
}

// Splits text into alternating plain/matched segments for inline highlighting.
export function highlightSegments(text: string, query: string) {
  const needle = query.trim()
  if (!needle) return [{ text, match: false }]
  return text
    .split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"))
    .map((segment, index) => ({ text: segment, match: index % 2 === 1 }))
    .filter((segment) => segment.text !== "")
}

export function stepIndex(index: number, total: number, direction: 1 | -1) {
  if (total <= 0) return 0
  return (index + direction + total) % total
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringLeaves)
  if (value && typeof value === "object") return Object.values(value).flatMap(stringLeaves)
  return []
}

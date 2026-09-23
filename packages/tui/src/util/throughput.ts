import type { AssistantMessage, Part, ReasoningPart, TextPart } from "@opencode-ai/sdk/v2"

// Providers only report output tokens at step-finish, so while a response is streaming
// the token count is estimated from generated characters (~4 chars per token).
const CHARS_PER_TOKEN = 4
// Rates over very short windows are dominated by the first burst of deltas.
const MIN_WINDOW_MS = 1000

export function tokensPerSecond(tokens: number, startMs: number, endMs: number) {
  const elapsed = endMs - startMs
  if (tokens <= 0 || elapsed < MIN_WINDOW_MS) return
  return Math.round(tokens / (elapsed / 1000))
}

export function liveTokensPerSecond(message: AssistantMessage, parts: Part[], now: number) {
  const generated = parts.filter(isGenerated)
  const chars = generated.reduce((sum, part) => sum + part.text.length, 0)
  const window = generationWindow(message, generated, now)
  return tokensPerSecond(chars / CHARS_PER_TOKEN, window.start, window.end)
}

export function finalTokensPerSecond(message: AssistantMessage, parts: Part[]) {
  if (!message.time.completed) return
  const window = generationWindow(message, parts.filter(isGenerated), message.time.completed)
  return tokensPerSecond(message.tokens.output + message.tokens.reasoning, window.start, window.end)
}

function isGenerated(part: Part): part is TextPart | ReasoningPart {
  return part.type === "text" || part.type === "reasoning"
}

// Measure from the first streamed token rather than message creation so time-to-first-token
// latency does not deflate the rate, and stop at the last finished text/reasoning part so
// tool execution time does not either. Any still-open part keeps the window running to `now`.
function generationWindow(message: AssistantMessage, parts: (TextPart | ReasoningPart)[], now: number) {
  const timed = parts.flatMap((part) => (part.time ? [part.time] : []))
  if (timed.length === 0) return { start: message.time.created, end: now }
  return {
    start: Math.min(...timed.map((time) => time.start)),
    end: timed.some((time) => time.end === undefined) ? now : Math.max(...timed.map((time) => time.end ?? now)),
  }
}

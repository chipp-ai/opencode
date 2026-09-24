export * as EventPersistPolicy from "./persist-policy"

// Pure redact/truncate transforms for the durable copy of an event payload. Wire them in through
// `EventV2.layerWith({ persist: EventPersistPolicy.apply })`. Both passes only change string leaves and are
// idempotent. Replay compares a re-encoded payload with the stored row, so a second pass must be a no-op.

export interface Pattern {
  readonly label: string
  readonly pattern: RegExp
  /** `String.prototype.replace` replacement; defaults to `[REDACTED:<label>]`. */
  readonly replacement?: string
}

// Scoped to well-known credential shapes so ordinary content (titles, paths, diffs) is left alone.
export const PATTERNS: ReadonlyArray<Pattern> = [
  // Must run before openai-key: "sk-ant-..." also matches the generic "sk-" shape.
  { label: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: "openai-key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/g },
  { label: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    label: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // `FOO_TOKEN=...` as printed by `env` or a `.env` file. Requires a secret-ish name suffix so plain
  // `NAME=value` content survives, and keeps the name so the output stays readable.
  {
    label: "env-assignment",
    pattern: /\b([A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|_PASSWORD|API_KEY))\s*[=:]\s*\S{8,}/g,
    replacement: "$1=[REDACTED:env-assignment]",
  },
]

export const MAX_STRING_BYTES = 256 * 1024

export function redactString(input: string, patterns: ReadonlyArray<Pattern> = PATTERNS) {
  return patterns.reduce(
    (output, entry) => output.replace(entry.pattern, entry.replacement ?? `[REDACTED:${entry.label}]`),
    input,
  )
}

/**
 * Bounds a string to `maxBytes` UTF-8 bytes including the appended marker, so re-truncating the result is a
 * no-op. Returns the input unchanged when it already fits.
 */
export function truncateString(input: string, maxBytes = MAX_STRING_BYTES) {
  const encoded = new TextEncoder().encode(input)
  if (encoded.length <= maxBytes) return input
  const marker = `\n\n[truncated: original length ${encoded.length} bytes, truncated to ${maxBytes} bytes]`
  const budget = Math.max(0, maxBytes - new TextEncoder().encode(marker).length)
  return new TextDecoder().decode(encoded.subarray(0, codepointBoundary(encoded, budget))) + marker
}

export const redactDeep = <T>(value: T, patterns: ReadonlyArray<Pattern> = PATTERNS) =>
  mapStrings(value, (input) => redactString(input, patterns))

export const truncateDeep = <T>(value: T, maxBytes = MAX_STRING_BYTES) =>
  mapStrings(value, (input) => truncateString(input, maxBytes))

/** Redacts before truncating so a truncation cut can never leave half of a credential unmatched. */
export const apply = <T>(value: T) => truncateDeep(redactDeep(value))

function mapStrings<T>(value: T, map: (input: string) => string): T {
  if (typeof value === "string") return map(value) as T
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map)) as T
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)])) as T
}

// Largest cut <= limit that does not split a multi-byte sequence (UTF-8 continuation bytes are 0b10xxxxxx).
function codepointBoundary(bytes: Uint8Array, limit: number) {
  const cut = Math.min(limit, bytes.length)
  if (cut === bytes.length) return cut
  const back = [0, 1, 2, 3].find((offset) => cut - offset <= 0 || (bytes[cut - offset] & 0xc0) !== 0x80) ?? 0
  return Math.max(0, cut - back)
}

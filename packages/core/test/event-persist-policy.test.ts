import { describe, expect, test } from "bun:test"
import { EventPersistPolicy } from "@opencode-ai/core/event/persist-policy"

const bytes = (value: string) => new TextEncoder().encode(value).length

describe("EventPersistPolicy.redactString", () => {
  test("redacts known credential shapes", () => {
    expect(EventPersistPolicy.redactString("here is sk-abcdefghijklmnopqrstuvwxyz123456 for you")).toBe(
      "here is [REDACTED:openai-key] for you",
    )
    expect(EventPersistPolicy.redactString("key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe(
      "key: [REDACTED:anthropic-key]",
    )
    expect(EventPersistPolicy.redactString("token ghp_abcdefghijklmnopqrstuvwxyzABCDEF")).toBe(
      "token [REDACTED:github-token]",
    )
    expect(EventPersistPolicy.redactString("aws AKIAABCDEFGHIJKLMNOP done")).toBe(
      "aws [REDACTED:aws-access-key-id] done",
    )
    const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----"
    expect(EventPersistPolicy.redactString(block)).toBe("[REDACTED:private-key-block]")
  })

  test("keeps the variable name of secret-looking env assignments", () => {
    expect(EventPersistPolicy.redactString("STRIPE_API_KEY=sk_live_abcdefghijklmnop")).toBe(
      "STRIPE_API_KEY=[REDACTED:env-assignment]",
    )
  })

  test("leaves ordinary content untouched", () => {
    const text = "Refactor src/session/sk-parser.ts: NODE_ENV=production, PATH=/usr/bin, ask-mode sk-short"
    expect(EventPersistPolicy.redactString(text)).toBe(text)
  })

  test("accepts a custom pattern registry", () => {
    const patterns = [{ label: "internal", pattern: /\bint_[a-z0-9]{8,}\b/g }]
    expect(EventPersistPolicy.redactString("use int_abcd1234efgh", patterns)).toBe("use [REDACTED:internal]")
    expect(EventPersistPolicy.redactString("sk-abcdefghijklmnopqrstuvwxyz123456", patterns)).toBe(
      "sk-abcdefghijklmnopqrstuvwxyz123456",
    )
  })
})

describe("EventPersistPolicy.truncateString", () => {
  test("returns strings within the limit unchanged", () => {
    const text = "x".repeat(EventPersistPolicy.MAX_STRING_BYTES)
    expect(EventPersistPolicy.truncateString(text)).toBe(text)
  })

  test("bounds a giant string to the limit including a truncation marker", () => {
    const original = EventPersistPolicy.MAX_STRING_BYTES + 50_000
    const result = EventPersistPolicy.truncateString("y".repeat(original))
    expect(bytes(result)).toBeLessThanOrEqual(EventPersistPolicy.MAX_STRING_BYTES)
    expect(result.startsWith("yyyy")).toBe(true)
    expect(result).toEndWith(
      `[truncated: original length ${original} bytes, truncated to ${EventPersistPolicy.MAX_STRING_BYTES} bytes]`,
    )
  })

  test("never splits a multi-byte character", () => {
    const result = EventPersistPolicy.truncateString("é".repeat(100), 101)
    expect(result).not.toContain("�")
    expect(bytes(result)).toBeLessThanOrEqual(101)
  })

  test("is idempotent", () => {
    const once = EventPersistPolicy.truncateString("z".repeat(10_000), 1_000)
    expect(EventPersistPolicy.truncateString(once, 1_000)).toBe(once)
  })
})

describe("EventPersistPolicy.apply", () => {
  test("walks nested payloads and only rewrites affected string leaves", () => {
    const giant = "line\n".repeat(EventPersistPolicy.MAX_STRING_BYTES)
    const input = {
      sessionID: "ses_1",
      count: 3,
      flag: true,
      missing: null,
      content: [
        { type: "text", text: "export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456" },
        { type: "text", text: giant },
        { type: "text", text: "plain output" },
      ],
    }
    const result = EventPersistPolicy.apply(input)
    expect(result.sessionID).toBe("ses_1")
    expect(result.count).toBe(3)
    expect(result.flag).toBe(true)
    expect(result.missing).toBeNull()
    expect(result.content[0].text).toBe("export OPENAI_API_KEY=[REDACTED:env-assignment]")
    expect(bytes(result.content[1].text)).toBeLessThanOrEqual(EventPersistPolicy.MAX_STRING_BYTES)
    expect(result.content[1].text).toContain("[truncated: original length")
    expect(result.content[2]).toEqual({ type: "text", text: "plain output" })
    expect(input.content[1].text).toBe(giant)
  })

  test("redacts before truncating so a cut cannot expose half a credential", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"
    // Place the secret so the truncation cut (limit minus the ~70 byte marker) lands inside it.
    const text = `${" ".repeat(EventPersistPolicy.MAX_STRING_BYTES - 110)}${secret}${" b".repeat(100)}`
    expect(EventPersistPolicy.truncateString(text)).toContain("sk-abcdef")
    expect(EventPersistPolicy.apply({ text }).text).not.toContain("sk-abcdef")
  })

  test("is idempotent", () => {
    const input = { text: `ghp_abcdefghijklmnopqrstuvwxyzABCDEF ${"q".repeat(EventPersistPolicy.MAX_STRING_BYTES)}` }
    const once = EventPersistPolicy.apply(input)
    expect(EventPersistPolicy.apply(once)).toEqual(once)
  })
})

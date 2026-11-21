import { describe, test, expect } from "bun:test"
import { Truncate } from "@/tool/truncate"

describe("Truncate.headTail", () => {
  test("keeps the first and last lines and counts what it left out", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n")
    const cut = Truncate.headTail(text, 100, 1_000_000)
    expect(cut.head.split("\n")[0]).toBe("line 0")
    expect(cut.head.split("\n").length).toBe(50)
    expect(cut.tail.split("\n").at(-1)).toBe("line 999")
    expect(cut.tail.split("\n").length).toBe(50)
    expect(cut.omittedLines).toBe(900)
    expect(cut.totalLines).toBe(1000)
    expect(cut.totalBytes).toBe(Buffer.byteLength(text))
  })

  test("never repeats a line when the text barely exceeds the limit", () => {
    const text = ["a", "b", "c"].join("\n")
    const cut = Truncate.headTail(text, 2, 1_000)
    expect(cut.head).toBe("a")
    expect(cut.tail).toBe("c")
    expect(cut.omittedLines).toBe(1)
  })

  test("splits the byte budget between head and tail", () => {
    const text = Array.from({ length: 100 }, () => "x".repeat(100)).join("\n")
    const cut = Truncate.headTail(text, 10_000, 1_000)
    expect(Buffer.byteLength(cut.head)).toBeLessThanOrEqual(500)
    expect(Buffer.byteLength(cut.tail)).toBeLessThanOrEqual(500)
    expect(cut.omittedBytes).toBeGreaterThan(8_000)
  })
})

describe("Truncate.capAttachments", () => {
  test("keeps everything with no limit", () => {
    const list = [1, 2, 3]
    expect(Truncate.capAttachments(list, undefined)).toEqual({ kept: list, note: "" })
  })
  test("keeps the first N and says how many it dropped", () => {
    const out = Truncate.capAttachments([1, 2, 3], 1)
    expect(out.kept).toEqual([1])
    expect(out.note).toContain("2 of 3 attachments omitted")
  })
  test("undefined attachments stay undefined", () => {
    expect(Truncate.capAttachments(undefined, 1)).toEqual({ kept: undefined, note: "" })
  })
})

describe("Truncate.capInstruction", () => {
  const item = { filepath: "/w/src/CLAUDE.md", content: Array.from({ length: 500 }, (_, i) => `rule ${i}`).join("\n") }
  test("a file under the limit, or no limit, is unchanged", () => {
    expect(Truncate.capInstruction(item, undefined)).toBe(item.content)
    expect(Truncate.capInstruction(item, 1_000_000)).toBe(item.content)
  })
  test("a large file keeps its start and names its path and size", () => {
    const out = Truncate.capInstruction(item, 200)
    expect(out.startsWith("rule 0")).toBe(true)
    expect(out).toContain("/w/src/CLAUDE.md")
    expect(out).toContain(`of ${Buffer.byteLength(item.content)} bytes`)
    expect(Buffer.byteLength(out)).toBeLessThan(500)
  })
})

import { describe, expect, test } from "bun:test"
import { parseSlashCommand } from "../../src/prompt/command"

const commands = [{ name: "review" }, { name: "deploy" }]

describe("parseSlashCommand", () => {
  test("ignores prompts that are not slash commands", () => {
    expect(parseSlashCommand("review this", commands)).toBeUndefined()
  })

  test("ignores unregistered commands so they are sent as plain prompts", () => {
    expect(parseSlashCommand("/unknown arg", commands)).toBeUndefined()
  })

  test("splits the command name from its first-line arguments", () => {
    expect(parseSlashCommand("/review src/app.ts carefully", commands)).toEqual({
      name: "review",
      arguments: "src/app.ts carefully",
    })
  })

  test("accepts a bare command with no arguments", () => {
    expect(parseSlashCommand("/deploy", commands)).toEqual({ name: "deploy", arguments: "" })
  })

  test("keeps following lines in the arguments", () => {
    expect(parseSlashCommand("/review one\ntwo\nthree", commands)).toEqual({
      name: "review",
      arguments: "one\ntwo\nthree",
    })
  })
})

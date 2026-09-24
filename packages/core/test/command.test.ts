import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(CommandV2.node))

describe("CommandV2", () => {
  it.effect("applies command transforms and preserves later overrides", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      yield* command.transform((editor) => {
        editor.update("review", (command) => {
          command.template = "First"
          command.description = "Review code"
        })
        editor.update("review", (command) => {
          command.template = "Second"
          command.model = {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          }
        })
      })

      expect(yield* command.get("review")).toEqual(
        CommandV2.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          },
        }),
      )
      expect(yield* command.list()).toEqual([
        CommandV2.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          },
        }),
      ])
    }),
  )
})

describe("CommandV2.render", () => {
  test("fills positional placeholders, letting the highest one swallow the rest", () => {
    expect(CommandV2.render("Compare $1 with $2", 'a.ts "b c.ts" d.ts')).toBe("Compare a.ts with b c.ts d.ts")
  })

  test("blanks placeholders with no matching argument", () => {
    expect(CommandV2.render("A=$1 B=$2", "only")).toBe("A=only B=")
  })

  test("substitutes $ARGUMENTS verbatim, including replacement-pattern characters", () => {
    expect(CommandV2.render("Run: $ARGUMENTS", "echo $& $1")).toBe("Run: echo $& $1")
  })

  test("appends raw arguments to a template without placeholders", () => {
    expect(CommandV2.render("Summarize", "the diff")).toBe("Summarize\n\nthe diff")
    expect(CommandV2.render("Summarize", "  ")).toBe("Summarize")
  })
})

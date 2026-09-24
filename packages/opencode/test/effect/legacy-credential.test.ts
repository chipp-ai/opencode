import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { LegacyCredential } from "../../src/effect/legacy-credential"
import { it } from "../lib/effect"

const withAuthContent = (value: unknown) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(value)
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previous
      }),
  )

describe("LegacyCredential", () => {
  it.live("exposes V1 API keys as V2 key credentials and reads the store on every call", () =>
    Effect.gen(function* () {
      yield* withAuthContent({
        openrouter: { type: "api", key: "or-key", metadata: { team: "a" } },
        openai: { type: "oauth", refresh: "r", access: "a", expires: 1 },
      })
      const legacy = yield* Credential.Legacy

      expect(yield* legacy()).toEqual({
        openrouter: Credential.Key.make({ type: "key", key: "or-key", metadata: { team: "a" } }),
      })

      // Disconnecting through the V1 flow takes effect without rebuilding the layer.
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({})
      expect(yield* legacy()).toEqual({})
    }).pipe(Effect.provide(LegacyCredential.layer)),
  )
})

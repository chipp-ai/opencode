import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Embed } from "../../src/embed"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { FACTORY_TOKEN_HEADER, FactoryPaths, factoryExtension } from "../fixture/route-extension"

// Embed state is process-wide by design, so this file registers once and owns that registration.
const delivered = new Array<EventV2.Delivery>()
const hooked = new Array<string>()
Embed.register({
  name: "embed-test",
  routeExtensions: [factoryExtension("embed-token")],
  deliver: (delivery) => Effect.sync(() => delivered.push(delivery)),
  plugins: [
    async () => {
      hooked.push("init")
      return {}
    },
  ],
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Embed", () => {
  test("refuses a second contribution that supplies deliver", () => {
    expect(() => Embed.register({ name: "second", deliver: () => Effect.void })).toThrow(/already supplies deliver/)
  })

  test("Server.listen serves registered routes, delivers durable events and loads embedded plugins", async () => {
    await using dir = await tmpdir({ git: true })
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const ping = await fetch(new URL(FactoryPaths.ping, listener.url), {
        headers: { [FACTORY_TOKEN_HEADER]: "embed-token" },
      })
      expect(ping.status).toBe(200)

      const created = await fetch(new URL("/session", listener.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-directory": dir.path },
        body: JSON.stringify({}),
      })
      expect(created.status).toBe(200)
      const session = (await created.json()) as { id: string }
      expect(delivered.some((item) => item.aggregateID === session.id && item.seq === 0)).toBe(true)
      expect(hooked).toContain("init")
    } finally {
      await listener.stop(true)
    }
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Obviously fake, but matches `EventPersistPolicy`'s openai-key shape.
const secret = "sk-proj-FAKEFAKEFAKEFAKEFAKEFAKE0123456789"
const title = `deploy with ${secret} today`
const original = {
  password: Flag.OPENCODE_SERVER_PASSWORD,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
  redact: process.env.OPENCODE_EVENT_REDACT_ENABLED,
}

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = original.password
  restoreEnv("OPENCODE_SERVER_PASSWORD", original.envPassword)
  restoreEnv("OPENCODE_EVENT_REDACT_ENABLED", original.redact)
  await disposeAllInstances()
  await resetDatabase()
})

describe("durable event persist hook through Server.listen", () => {
  test("stores durable events unchanged by default", async () => {
    delete process.env.OPENCODE_EVENT_REDACT_ENABLED
    const result = await createSession({})

    expect(result.response.title).toBe(title)
    expect(result.stored.title).toBe(title)
    expect(result.projected).toBe(title)
  })

  test("OPENCODE_EVENT_REDACT_ENABLED applies EventPersistPolicy to the event log only", async () => {
    process.env.OPENCODE_EVENT_REDACT_ENABLED = "true"
    const result = await createSession({})

    expect(result.stored.title).toBe("deploy with [REDACTED:openai-key] today")
    // Live behavior is untouched: the API response and the projected session keep the original value.
    expect(result.response.title).toBe(title)
    expect(result.projected).toBe(title)
  })

  test("an embedder-supplied persist function overrides the built-in policy", async () => {
    process.env.OPENCODE_EVENT_REDACT_ENABLED = "true"
    const result = await createSession({
      persist: (data) => ({ ...data, info: { ...(data.info as Record<string, unknown>), title: "custom" } }),
    })

    expect(result.stored.title).toBe("custom")
    expect(result.response.title).toBe(title)
    expect(result.projected).toBe(title)
  })
})

async function createSession(options: Pick<Server.ListenOptions, "persist">) {
  Flag.OPENCODE_SERVER_PASSWORD = undefined
  delete process.env.OPENCODE_SERVER_PASSWORD
  await using dir = await tmpdir({ git: true })
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, ...options })
  const request = (path: string, init?: RequestInit) =>
    fetch(new URL(path, listener.url), {
      ...init,
      headers: { "content-type": "application/json", "x-opencode-directory": dir.path },
    })
  try {
    const created = await request("/session", { method: "POST", body: JSON.stringify({ title }) })
    expect(created.status).toBe(200)
    const session = (await created.json()) as { id: string; title: string }
    // `/sync/history` returns raw rows from the listener's own event table, i.e. exactly what was persisted.
    const history = (await (await request("/sync/history", { method: "POST", body: "{}" })).json()) as {
      aggregate_id: string
      type: string
      data: { info: { title: string } }
    }[]
    const event = history.find((item) => item.aggregate_id === session.id && item.type.startsWith("session.created"))
    const projected = (await (await request(`/session/${session.id}`)).json()) as { title: string }
    return { response: session, stored: event!.data.info, projected: projected.title }
  } finally {
    await listener.stop(true)
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

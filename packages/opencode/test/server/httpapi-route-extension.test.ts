import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { Flag } from "@opencode-ai/core/flag/flag"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { RouteExtension } from "../../src/server/routes/instance/httpapi/extension"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { FACTORY_TOKEN_HEADER, FactoryPaths, factoryExtension } from "../fixture/route-extension"
import { awaitWithTimeout, pollWithTimeout } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

const auth = { username: "opencode", password: "secret" }
const factoryToken = "factory-secret"
const original = {
  flagPassword: Flag.OPENCODE_SERVER_PASSWORD,
  flagUsername: Flag.OPENCODE_SERVER_USERNAME,
  envPassword: process.env.OPENCODE_SERVER_PASSWORD,
  envUsername: process.env.OPENCODE_SERVER_USERNAME,
}

function app(extensions: ReadonlyArray<RouteExtension.RouteExtension>) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.createRoutes(undefined, { routeExtensions: extensions }).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: auth.password,
            OPENCODE_SERVER_USERNAME: auth.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return (path: string, headers: Record<string, string> = {}) =>
    handler(new Request(new URL(path, "http://localhost"), { headers }), HttpApiApp.context)
}

const basic = { authorization: ServerAuth.header(auth) ?? "" }
const factory = { [FACTORY_TOKEN_HEADER]: factoryToken }

afterEach(async () => {
  Flag.OPENCODE_SERVER_PASSWORD = original.flagPassword
  Flag.OPENCODE_SERVER_USERNAME = original.flagUsername
  if (original.envPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD
  else process.env.OPENCODE_SERVER_PASSWORD = original.envPassword
  if (original.envUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME
  else process.env.OPENCODE_SERVER_USERNAME = original.envUsername
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi route extensions", () => {
  test("serves a registered extension route behind its own middleware", async () => {
    const request = app([factoryExtension(factoryToken)])

    const ok = await request(FactoryPaths.ping, factory)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ service: "factory", database: true })

    const missing = await request(FactoryPaths.ping)
    expect(missing.status).toBe(401)
    expect(missing.headers.get("www-authenticate")).toBeNull()
    expect(await missing.json()).toEqual({ name: "FactoryUnauthorized" })

    // Main-server Basic credentials do not satisfy the extension's boundary.
    const basicOnly = await request(FactoryPaths.ping, basic)
    expect(basicOnly.status).toBe(401)
    expect(await basicOnly.json()).toEqual({ name: "FactoryUnauthorized" })
  })

  test("leaves main API routes and their auth unchanged when an extension is registered", async () => {
    const request = app([factoryExtension(factoryToken)])

    const missing = await request(GlobalPaths.health)
    expect(missing.status).toBe(401)
    expect(missing.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')

    const factoryOnly = await request(GlobalPaths.health, factory)
    expect(factoryOnly.status).toBe(401)

    const authed = await request(GlobalPaths.health, basic)
    expect(authed.status).toBe(200)
    expect(await authed.json()).toMatchObject({ healthy: true })
  })

  test("without extensions the extension path is unmounted and main routes behave as before", async () => {
    const request = app([])

    // Falls through to the auth-guarded UI catch-all, like any unknown path.
    const unmounted = await request(FactoryPaths.ping, factory)
    expect(unmounted.status).toBe(401)
    expect(unmounted.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')

    expect((await request(GlobalPaths.health)).status).toBe(401)
    expect((await request(GlobalPaths.health, basic)).status).toBe(200)
  })

  test("Server.listen mounts route extensions on a real listener", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = auth.password
    Flag.OPENCODE_SERVER_USERNAME = auth.username
    process.env.OPENCODE_SERVER_PASSWORD = auth.password
    process.env.OPENCODE_SERVER_USERNAME = auth.username
    const listener = await Server.listen({
      hostname: "127.0.0.1",
      port: 0,
      routeExtensions: [factoryExtension(factoryToken)],
    })
    try {
      const ok = await fetch(new URL(FactoryPaths.ping, listener.url), { headers: factory })
      expect(ok.status).toBe(200)
      expect(await ok.json()).toEqual({ service: "factory", database: true })

      const missing = await fetch(new URL(FactoryPaths.ping, listener.url))
      expect(missing.status).toBe(401)
      expect(await missing.json()).toEqual({ name: "FactoryUnauthorized" })

      expect((await fetch(new URL(GlobalPaths.health, listener.url))).status).toBe(401)
      expect((await fetch(new URL(GlobalPaths.health, listener.url), { headers: basic })).status).toBe(200)
    } finally {
      await listener.stop(true)
    }
  })

  test("an extension route continues a V2 session without holding the response for the model turn", () =>
    Effect.gen(function* () {
      Flag.OPENCODE_SERVER_PASSWORD = undefined
      delete process.env.OPENCODE_SERVER_PASSWORD
      const llm = yield* TestLLMServer
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir({ git: true })),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ).pipe(Effect.map((dir) => dir.path))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory, "opencode.json"),
          JSON.stringify({
            providers: {
              test: {
                api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: llm.url, settings: {} },
                request: { body: { apiKey: "test-key" } },
                models: { "test-model": { limit: { context: 100_000, output: 10_000 } } },
              },
            },
          }),
        ),
      )
      const listener = yield* Effect.acquireRelease(
        Effect.promise(() =>
          Server.listen({ hostname: "127.0.0.1", port: 0, routeExtensions: [factoryExtension(factoryToken)] }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const request = (url: string, init?: RequestInit) =>
        Effect.promise(() =>
          fetch(new URL(url, listener.url), {
            ...init,
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": directory,
              ...factory,
              ...(init?.headers as Record<string, string> | undefined),
            },
          }),
        )
      const json = <T>(response: Response) => Effect.promise(() => response.json() as Promise<T>)

      const created = yield* request("/api/session", {
        method: "POST",
        body: JSON.stringify({ model: { providerID: "test", id: "test-model" }, location: { directory } }),
      }).pipe(Effect.flatMap((response) => json<{ data: { id: string } }>(response)))
      const sessionID = created.data.id
      // Location plugins populate the V2 catalog asynchronously after the Location boots.
      yield* pollWithTimeout(
        request("/api/provider").pipe(
          Effect.flatMap((response) => json<{ data: { id: string }[] }>(response)),
          Effect.map(({ data }) => data.find((provider) => provider.id === "test")),
        ),
        "configured test provider never reached the V2 catalog",
      )
      const admitted = yield* request(`/api/session/${sessionID}/prompt`, {
        method: "POST",
        body: JSON.stringify({ prompt: { text: "continue me" }, resume: false }),
      })
      expect(admitted.status).toBe(200)

      // The fake provider holds its reply until released, so the turn cannot finish before the response returns.
      const release = Promise.withResolvers<void>()
      yield* llm.hold("continued answer", release.promise)
      const continued = yield* request(FactoryPaths.continue.replace(":sessionID", sessionID), { method: "POST" })
      expect(continued.status).toBe(200)
      expect(yield* json(continued)).toEqual({ started: true })

      const context = (url: string) =>
        request(url).pipe(Effect.flatMap((response) => json<{ data: { type: string }[] }>(response)))
      // The response arrived while the provider was still holding the turn, so nothing has answered yet.
      expect((yield* context(`/api/session/${sessionID}/context`)).data.map((message) => message.type)).not.toContain(
        "assistant",
      )
      yield* awaitWithTimeout(llm.wait(1), "continue never reached the provider")

      release.resolve()
      expect((yield* request(`/api/session/${sessionID}/wait`, { method: "POST" })).status).toBe(204)
      expect((yield* context(`/api/session/${sessionID}/context`)).data.map((message) => message.type)).toEqual([
        "user",
        "assistant",
      ])

      const missing = yield* request(FactoryPaths.continue.replace(":sessionID", "ses_missing_factory"), {
        method: "POST",
      })
      expect(missing.status).toBe(404)
      expect(yield* json(missing)).toEqual({ name: "FactorySessionNotFound", sessionID: "ses_missing_factory" })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped, Effect.runPromise),
  )
})

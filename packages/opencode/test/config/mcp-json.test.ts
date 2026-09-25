import { describe, expect, test } from "bun:test"
import path from "path"
import { ConfigMcpJson } from "@/config/mcp-json"
import { tmpdir } from "../fixture/fixture"

async function writeMcpJson(dir: string, content: unknown) {
  await Bun.write(path.join(dir, ".mcp.json"), JSON.stringify(content, null, 2))
}

describe("ConfigMcpJson.load", () => {
  test("discovers a local (stdio) server and combines command + args", async () => {
    await using tmp = await tmpdir()
    await writeMcpJson(tmp.path, {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      },
    })

    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"))

    expect(result.diagnostics).toEqual([])
    expect(result.servers.filesystem).toEqual({
      type: "local",
      command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      cwd: undefined,
      environment: undefined,
    })
  })

  test("discovers a remote (http) server", async () => {
    await using tmp = await tmpdir()
    await writeMcpJson(tmp.path, {
      mcpServers: {
        docs: {
          type: "http",
          url: "https://docs.example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
    })

    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"))

    expect(result.diagnostics).toEqual([])
    expect(result.servers.docs).toEqual({
      type: "remote",
      url: "https://docs.example.com/mcp",
      headers: { Authorization: "Bearer token" },
    })
  })

  test("treats streamable-http and sse the same as http", async () => {
    await using tmp = await tmpdir()
    await writeMcpJson(tmp.path, {
      mcpServers: {
        a: { type: "streamable-http", url: "https://a.example.com/mcp" },
        b: { type: "sse", url: "https://b.example.com/mcp" },
      },
    })

    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"))

    expect(result.servers.a?.type).toBe("remote")
    expect(result.servers.b?.type).toBe("remote")
  })

  test("infers remote type from a bare url with no explicit type", async () => {
    await using tmp = await tmpdir()
    await writeMcpJson(tmp.path, {
      mcpServers: { implicit: { url: "https://implicit.example.com/mcp" } },
    })

    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"))

    expect(result.servers.implicit).toEqual({
      type: "remote",
      url: "https://implicit.example.com/mcp",
      headers: undefined,
    })
  })

  test("translates plain ${VAR} env values to {env:VAR}", async () => {
    await using tmp = await tmpdir()
    await writeMcpJson(tmp.path, {
      mcpServers: {
        server: {
          command: "my-mcp",
          env: { API_KEY: "${MY_API_KEY}", GREETING: "hello ${NAME}!" },
        },
      },
    })

    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"))

    expect(result.diagnostics).toEqual([])
    expect(result.servers.server?.type).toBe("local")
    expect(result.servers.server && result.servers.server.type === "local" ? result.servers.server.environment : undefined).toEqual({
      API_KEY: "{env:MY_API_KEY}",
      GREETING: "hello {env:NAME}!",
    })
  })

  test("drops ${VAR:-default} env values entirely and logs a diagnostic naming the variable, default, and file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mcp.json")
    await writeMcpJson(tmp.path, {
      mcpServers: {
        server: {
          command: "my-mcp",
          env: { PORT: "${PORT:-3000}", TOKEN: "${TOKEN}" },
        },
      },
    })

    const result = await ConfigMcpJson.load(file)

    const environment = result.servers.server && result.servers.server.type === "local" ? result.servers.server.environment : undefined
    expect(environment).toEqual({ TOKEN: "{env:TOKEN}" })
    expect(environment).not.toHaveProperty("PORT")

    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.file).toBe(file)
    expect(result.diagnostics[0]?.message).toContain("PORT")
    expect(result.diagnostics[0]?.message).toContain("3000")
  })

  test("skips a ws (WebSocket) entry with a diagnostic naming the server and file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mcp.json")
    await writeMcpJson(tmp.path, {
      mcpServers: {
        pusher: { type: "ws", url: "wss://pusher.example.com/mcp" },
      },
    })

    const result = await ConfigMcpJson.load(file)

    expect(result.servers.pusher).toBeUndefined()
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.file).toBe(file)
    expect(result.diagnostics[0]?.message).toContain("pusher")
    expect(result.diagnostics[0]?.message).toContain("ws")
  })

  test("does not crash on a malformed/garbage .mcp.json and reports a diagnostic", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mcp.json")
    await Bun.write(file, "{ this is not valid json ")

    const result = await ConfigMcpJson.load(file)

    expect(result.servers).toEqual({})
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.file).toBe(file)
  })

  test("a foreign-shaped JSON file with no mcpServers key yields nothing, no diagnostic", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mcp.json")
    await Bun.write(file, JSON.stringify({ unrelated: true }))

    const result = await ConfigMcpJson.load(file)

    expect(result.servers).toEqual({})
    expect(result.diagnostics).toEqual([])
  })

  test("missing .mcp.json file yields nothing, no diagnostic", async () => {
    await using tmp = await tmpdir()
    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"))

    expect(result.servers).toEqual({})
    expect(result.diagnostics).toEqual([])
  })
})

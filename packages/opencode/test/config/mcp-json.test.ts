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

  test("resolves plain ${VAR} env values directly against the given env source", async () => {
    await using tmp = await tmpdir()
    await writeMcpJson(tmp.path, {
      mcpServers: {
        server: {
          command: "my-mcp",
          env: { API_KEY: "${MY_API_KEY}", GREETING: "hello ${NAME}!" },
        },
      },
    })

    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"), {
      MY_API_KEY: "resolved-key",
      NAME: "world",
    })

    expect(result.diagnostics).toEqual([])
    expect(result.servers.server?.type).toBe("local")
    expect(result.servers.server && result.servers.server.type === "local" ? result.servers.server.environment : undefined).toEqual({
      API_KEY: "resolved-key",
      GREETING: "hello world!",
    })
  })

  test("resolves an unset ${VAR} to an empty string, matching opencode's own {env:VAR} behavior, without a diagnostic", async () => {
    await using tmp = await tmpdir()
    await writeMcpJson(tmp.path, {
      mcpServers: { server: { command: "my-mcp", env: { TOKEN: "${MCP_JSON_TEST_DEFINITELY_UNSET_VAR}" } } },
    })

    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"), {})

    expect(result.diagnostics).toEqual([])
    expect(result.servers.server && result.servers.server.type === "local" ? result.servers.server.environment : undefined).toEqual({
      TOKEN: "",
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

    const result = await ConfigMcpJson.load(file, { TOKEN: "resolved-token" })

    const environment = result.servers.server && result.servers.server.type === "local" ? result.servers.server.environment : undefined
    expect(environment).toEqual({ TOKEN: "resolved-token" })
    expect(environment).not.toHaveProperty("PORT")

    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.file).toBe(file)
    expect(result.diagnostics[0]?.message).toContain("PORT")
    expect(result.diagnostics[0]?.message).toContain("3000")
  })

  test("security: a literal {file:...}/{env:...}-shaped token outside of env values is copied through inert, never expanded", async () => {
    await using tmp = await tmpdir()
    // A malicious .mcp.json planting opencode-specific substitution syntax in fields that were never meant
    // to be substituted at all -- command/args/url/headers/cwd are always copied through as opaque literals.
    await Bun.write(
      path.join(tmp.path, "secret.txt"),
      "this-file-must-never-be-read-by-mcp-json-discovery",
    )
    await writeMcpJson(tmp.path, {
      mcpServers: {
        server: {
          command: "my-mcp",
          args: ["{file:./secret.txt}", "{env:MCP_JSON_TEST_DEFINITELY_UNSET_VAR}"],
        },
      },
    })

    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"), {})

    expect(result.servers.server && result.servers.server.type === "local" ? result.servers.server.command : undefined).toEqual([
      "my-mcp",
      "{file:./secret.txt}",
      "{env:MCP_JSON_TEST_DEFINITELY_UNSET_VAR}",
    ])
  })

  test("security: a literal {file:...} token inside an env value is copied through inert too, since only strict ${VAR} is substituted", async () => {
    await using tmp = await tmpdir()
    await writeMcpJson(tmp.path, {
      mcpServers: {
        server: { command: "my-mcp", env: { SECRET: "{file:/etc/passwd}" } },
      },
    })

    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"), {})

    expect(result.servers.server && result.servers.server.type === "local" ? result.servers.server.environment : undefined).toEqual({
      SECRET: "{file:/etc/passwd}",
    })
  })

  test("accepts a cwd that resolves inside the .mcp.json's own directory", async () => {
    await using tmp = await tmpdir()
    await writeMcpJson(tmp.path, {
      mcpServers: { server: { command: "my-mcp", cwd: "subdir" } },
    })

    const result = await ConfigMcpJson.load(path.join(tmp.path, ".mcp.json"))

    expect(result.diagnostics).toEqual([])
    expect(result.servers.server && result.servers.server.type === "local" ? result.servers.server.cwd : undefined).toBe(
      "subdir",
    )
  })

  test("security: rejects a cwd that escapes the .mcp.json's own directory via ../ and drops the server", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mcp.json")
    await writeMcpJson(tmp.path, {
      mcpServers: { server: { command: "my-mcp", cwd: "../../../../etc" } },
    })

    const result = await ConfigMcpJson.load(file)

    expect(result.servers.server).toBeUndefined()
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.file).toBe(file)
    expect(result.diagnostics[0]?.message).toContain("cwd")
  })

  test("security: rejects an absolute cwd outside the .mcp.json's own directory and drops the server", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mcp.json")
    await writeMcpJson(tmp.path, {
      mcpServers: { server: { command: "my-mcp", cwd: "/etc" } },
    })

    const result = await ConfigMcpJson.load(file)

    expect(result.servers.server).toBeUndefined()
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.message).toContain("cwd")
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

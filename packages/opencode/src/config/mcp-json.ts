export * as ConfigMcpJson from "./mcp-json"

import path from "path"
import { type ParseError as JsoncParseError, parse as parseJsonc } from "jsonc-parser"
import { Option, Schema } from "effect"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { isRecord } from "@/util/record"
import { Filesystem } from "@/util/filesystem"

export type Diagnostic = { file: string; message: string }

export type Result = {
  servers: Record<string, ConfigMCPV1.Info>
  diagnostics: Diagnostic[]
}

// Real-world `.mcp.json` entries (Claude Code/Cursor/Claude Desktop): a `command`+optional `args`/`env`/`cwd`
// shape means local/stdio, a `url`+optional `headers` shape means remote. `type` is explicit when present but
// commonly omitted for stdio servers.
const RawServer = Schema.Struct({
  type: Schema.optional(Schema.Literals(["stdio", "http", "streamable-http", "sse", "ws"])),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
type RawServer = Schema.Schema.Type<typeof RawServer>

const decodeServer = Schema.decodeUnknownOption(RawServer)

// Bash-style `${VAR:-default}` fallback syntax. opencode's own `{env:VAR}` substitution has no default-value
// support, so a value using this form can't be translated faithfully — the whole key is dropped instead of
// silently baking in an empty string or the wrong default.
const DEFAULT_VALUE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/
const PLAIN_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Discovers and translates a `.mcp.json` file at the given path. Never throws: parse/shape problems are
 * reported as diagnostics for the caller to log, and discovery simply contributes nothing.
 *
 * Security note: every field except `env` values is copied through as an opaque, literal string — `command`,
 * `args`, `url`, `headers`, and `cwd` are never passed through any substitution or expansion. `.mcp.json` is a
 * foreign, casually-trusted convention (pasted from READMEs, MCP marketplaces, etc.), not a file authored with
 * opencode's own `{env:...}`/`{file:...}` templating in mind. Only `env` values are resolved, and only against
 * `${VAR}` (a strict identifier, never a wildcard match on arbitrary text), directly against `envSource` /
 * `process.env` — never through the general-purpose `ConfigVariable.substitute`, which also expands
 * `{file:path}`. Doing so would let a malicious `.mcp.json` embed a literal `{file:~/.ssh/id_rsa}`-shaped token
 * in `args`/`url`/`cwd`/a non-`${}` env value and have opencode read that file's contents into a value handed
 * straight to a locally-spawned process the same file controls. */
export async function load(file: string, envSource?: Record<string, string>): Promise<Result> {
  const text = await Filesystem.readText(file).catch(() => undefined)
  if (!text) return { servers: {}, diagnostics: [] }

  const errors: JsoncParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length || !isRecord(data)) {
    return { servers: {}, diagnostics: [{ file, message: "failed to parse .mcp.json, skipping" }] }
  }
  if (!isRecord(data.mcpServers)) return { servers: {}, diagnostics: [] }

  const servers: Record<string, ConfigMCPV1.Info> = {}
  const diagnostics: Diagnostic[] = []
  const baseDir = path.dirname(file)

  for (const [name, raw] of Object.entries(data.mcpServers)) {
    const decoded = decodeServer(raw)
    if (Option.isNone(decoded)) {
      diagnostics.push({ file, message: `skipping MCP server "${name}": does not match the expected .mcp.json shape` })
      continue
    }
    const entry = translateServer(name, decoded.value, file, baseDir, envSource, diagnostics)
    if (entry) servers[name] = entry
  }

  return { servers, diagnostics }
}

function translateServer(
  name: string,
  raw: RawServer,
  file: string,
  baseDir: string,
  envSource: Record<string, string> | undefined,
  diagnostics: Diagnostic[],
): ConfigMCPV1.Info | undefined {
  if (raw.type === "ws") {
    // opencode's remote MCP client only ever tries StreamableHTTP and SSE transports (see
    // `packages/opencode/src/mcp/index.ts`'s `connectRemote`); it has no WebSocket transport, so a `remote`
    // entry here would just fail to connect.
    diagnostics.push({
      file,
      message: `skipping MCP server "${name}": type "ws" (WebSocket) is not supported by opencode's remote MCP client`,
    })
    return undefined
  }

  const isRemote = raw.type === "http" || raw.type === "streamable-http" || raw.type === "sse" || raw.url !== undefined
  if (isRemote) {
    if (!raw.url) {
      diagnostics.push({ file, message: `skipping MCP server "${name}": remote server is missing "url"` })
      return undefined
    }
    // url/headers are copied through opaque, unmodified -- see the module-level security note.
    return { type: "remote", url: raw.url, headers: raw.headers }
  }

  if (!raw.command) {
    diagnostics.push({ file, message: `skipping MCP server "${name}": local server is missing "command"` })
    return undefined
  }

  const cwd = resolveCwd(name, raw.cwd, file, baseDir, diagnostics)
  if (raw.cwd && !cwd) return undefined

  return {
    type: "local",
    // command/args are copied through opaque, unmodified -- see the module-level security note.
    command: [raw.command, ...(raw.args ?? [])],
    cwd,
    environment: translateEnvironment(name, raw.env, file, envSource, diagnostics),
  }
}

/** A `.mcp.json`-declared `cwd` must resolve inside the directory the file itself lives in. Local MCP servers
 * are spawned relative to `InstanceState.directory` (the project root), and a `.mcp.json` was never meant to
 * redirect that anywhere else on disk -- reject `..`-escapes and absolute paths outside the project rather than
 * silently spawn a configured command in an arbitrary directory the file's author chose. */
function resolveCwd(
  name: string,
  cwd: string | undefined,
  file: string,
  baseDir: string,
  diagnostics: Diagnostic[],
): string | undefined {
  if (!cwd) return undefined
  const resolved = path.resolve(baseDir, cwd)
  const relative = path.relative(baseDir, resolved)
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return cwd
  diagnostics.push({
    file,
    message: `skipping MCP server "${name}": "cwd" ("${cwd}") resolves outside the .mcp.json's own directory`,
  })
  return undefined
}

function translateEnvironment(
  serverName: string,
  env: Record<string, string> | undefined,
  file: string,
  envSource: Record<string, string> | undefined,
  diagnostics: Diagnostic[],
) {
  if (!env) return undefined
  const translated = Object.fromEntries(
    Object.entries(env)
      .map(([key, value]): [string, string | undefined] => [
        key,
        translateEnvValue(serverName, key, value, file, envSource, diagnostics),
      ])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return Object.keys(translated).length ? translated : undefined
}

function translateEnvValue(
  serverName: string,
  key: string,
  value: string,
  file: string,
  envSource: Record<string, string> | undefined,
  diagnostics: Diagnostic[],
) {
  const withDefault = value.match(DEFAULT_VALUE_PATTERN)
  if (withDefault) {
    diagnostics.push({
      file,
      message: `dropping environment variable "${key}" for MCP server "${serverName}": opencode's {env:VAR} substitution has no default-value support, so the "${withDefault[2]}" fallback in "\${${withDefault[1]}:-${withDefault[2]}}" cannot be preserved. Export ${withDefault[1]} directly if you rely on that default.`,
    })
    return undefined
  }
  // Resolved directly against a real env lookup here -- never routed through the general-purpose
  // ConfigVariable.substitute, which also expands `{file:path}` and would apply to this whole object were it
  // used. Only a strict `${IDENTIFIER}` shape is ever substituted; every other character in the value, including
  // any literal `{env:...}`/`{file:...}`-shaped text an author wrote here, passes through unmodified and inert.
  return value.replace(PLAIN_VAR_PATTERN, (_, name) => (envSource?.[name] ?? process.env[name]) || "")
}

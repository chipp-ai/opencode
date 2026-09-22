export * as McpResourceTools from "./mcp-resource.js"

import { ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Mcp } from "../../mcp/index.js"
import { Permission } from "../../permission.js"

export const Plugin = {
  id: "opencode.tools.mcp-resources",
  effect: Effect.fn("McpResourceTools.Plugin")(function* (ctx: Context) {
    const mcp = yield* Mcp.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) => {
        editor.add({
          name: "list_mcp_resources",
          options: { namespace: "opencode", codemode: true },
          description:
            "List documents, records, and other data exposed by connected MCP servers. Use this when the user refers to something that is not a local file, then load a match with read_mcp_resource.",
          input: Schema.Struct({
            server: Schema.optionalKey(
              Schema.String.annotate({
                description: "MCP server name as configured. Omit to search every server at once.",
              }),
            ),
            cursor: Schema.optionalKey(
              Schema.String.annotate({
                description: "nextCursor from the previous page. Requires server.",
              }),
            ),
          }),
          output: Schema.Struct({
            server: Schema.optionalKey(Schema.String),
            resources: Schema.Array(Mcp.Resource),
            nextCursor: Schema.optionalKey(Schema.String).annotate({
              description: "Pass as cursor with the same server for the next page.",
            }),
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.server === undefined && input.cursor !== undefined)
                return yield* new ToolFailure({ message: "cursor can only be used when a server is specified" })
              yield* permission.assert({
                action: "opencode_list_mcp_resources",
                resources: [input.server ?? "*"],
                save: [input.server ?? "*"],
                metadata: {},
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              return { output: yield* mcp.listResources(input) }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
        })
        editor.add({
          name: "list_mcp_resource_templates",
          options: { namespace: "opencode", codemode: true },
          description:
            "List MCP resources addressed by a parameter such as a record ID or table name. Fill in the returned uriTemplate placeholders, then load the result with read_mcp_resource.",
          input: Schema.Struct({
            server: Schema.optionalKey(
              Schema.String.annotate({
                description: "MCP server name as configured. Omit to search every server at once.",
              }),
            ),
            cursor: Schema.optionalKey(
              Schema.String.annotate({
                description: "nextCursor from the previous page. Requires server.",
              }),
            ),
          }),
          output: Schema.Struct({
            server: Schema.optionalKey(Schema.String),
            resourceTemplates: Schema.Array(Mcp.ResourceTemplate),
            nextCursor: Schema.optionalKey(Schema.String).annotate({
              description: "Pass as cursor with the same server for the next page.",
            }),
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.server === undefined && input.cursor !== undefined)
                return yield* new ToolFailure({ message: "cursor can only be used when a server is specified" })
              yield* permission.assert({
                action: "opencode_list_mcp_resource_templates",
                resources: [input.server ?? "*"],
                save: [input.server ?? "*"],
                metadata: {},
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              return { output: yield* mcp.listResourceTemplates(input) }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error }))),
        })
        editor.add({
          name: "read_mcp_resource",
          options: { namespace: "opencode", codemode: true },
          description:
            "Read one MCP resource by server and URI. Not for local files. Images and PDFs are shown to you directly; for large text, slice or filter the contents in Code Mode and return only what you need.",
          input: Schema.Struct({
            server: Schema.String.annotate({
              description: "The server field of the discovered resource.",
            }),
            uri: Schema.String.annotate({
              description: "Exact resource URI from discovery, an expanded uriTemplate, or the user.",
            }),
          }),
          output: Mcp.ResourceContent,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: "opencode_read_mcp_resource",
                resources: [`${input.server}:${input.uri}`],
                save: [`${input.server}:*`],
                metadata: { server: input.server, uri: input.uri },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              const resource = yield* mcp.readResource(input)
              if (!resource?.contents.length)
                return yield* new ToolFailure({ message: `Unable to read MCP resource: ${input.server}:${input.uri}` })
              return {
                output: resource,
                content: resource.contents.flatMap((part) =>
                  part.type === "blob" && (part.mimeType?.startsWith("image/") || part.mimeType === "application/pdf")
                    ? [{ type: "file" as const, uri: `data:${part.mimeType};base64,${part.blob}`, mime: part.mimeType }]
                    : [],
                ),
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: error.message, error }),
              ),
            ),
        })
      })
      .pipe(Effect.orDie)
  }),
}

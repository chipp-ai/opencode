import { describe, expect } from "bun:test"
import path from "path"
import { Effect, FileSystem } from "effect"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Workflow } from "@opencode-ai/schema/workflow"
import { WorkflowDiscovery } from "@opencode-ai/core/workflow/discovery"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem])))

const write = (files: FileSystem.FileSystem, directory: string, relativePath: string, content: string) =>
  Effect.gen(function* () {
    const full = path.join(directory, relativePath)
    yield* files.makeDirectory(path.dirname(full), { recursive: true })
    yield* files.writeFileString(full, content)
    return full
  })

describe("WorkflowDiscovery.list", () => {
  it.effect("returns an empty result when .opencode/workflows doesn't exist", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      const result = yield* WorkflowDiscovery.list(directory)
      expect(result).toEqual({ workflows: [], errors: [] })
    }),
  )

  it.effect("discovers a workflow file's meta and derives its id from the filename", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      yield* write(
        files,
        directory,
        ".opencode/workflows/hello.js",
        `export const meta = { name: 'Hello', description: 'says hello' }\nreturn "hi"`,
      )

      const result = yield* WorkflowDiscovery.list(directory)
      expect(result.errors).toEqual([])
      expect(result.workflows).toHaveLength(1)
      expect(result.workflows[0]).toMatchObject({ id: "hello", name: "Hello", description: "says hello" })
    }),
  )

  it.effect("reports a lint error for a file with no meta export, without failing other files", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      yield* write(files, directory, ".opencode/workflows/broken.js", `return 1`)
      yield* write(
        files,
        directory,
        ".opencode/workflows/good.js",
        `export const meta = { name: 'Good', description: 'works' }\nreturn 1`,
      )

      const result = yield* WorkflowDiscovery.list(directory)
      expect(result.workflows).toHaveLength(1)
      expect(result.workflows[0].id).toBe(Workflow.ID.make("good"))
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].message).toContain("missing a leading")
    }),
  )

  it.effect("reports a lint error when meta is missing a required field", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      yield* write(files, directory, ".opencode/workflows/no-description.js", `export const meta = { name: 'X' }\nreturn 1`)

      const result = yield* WorkflowDiscovery.list(directory)
      expect(result.workflows).toEqual([])
      expect(result.errors[0].message).toContain("meta.description is required")
    }),
  )
})

describe("WorkflowDiscovery.find", () => {
  it.effect("finds a workflow by id", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      yield* write(files, directory, ".opencode/workflows/hello.js", `export const meta = { name: 'Hello', description: 'd' }\nreturn 1`)

      const found = yield* WorkflowDiscovery.find(directory, "hello")
      expect(found?.name).toBe("Hello")
      expect(yield* WorkflowDiscovery.find(directory, "missing")).toBeUndefined()
    }),
  )
})

describe("WorkflowDiscovery.readBody", () => {
  it.effect("strips the leading meta export, leaving the runnable script body", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      const file = yield* write(
        files,
        directory,
        ".opencode/workflows/hello.js",
        `export const meta = { name: 'Hello', description: 'd' };\nreturn "the body ran"`,
      )

      const body = yield* WorkflowDiscovery.readBody(file)
      expect(body.trim()).toBe(`return "the body ran"`)
    }),
  )

  it.effect("returns the source unchanged when there's no meta export", () =>
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      const file = yield* write(files, directory, ".opencode/workflows/plain.js", `return 1`)

      const body = yield* WorkflowDiscovery.readBody(file)
      expect(body).toBe("return 1")
    }),
  )
})

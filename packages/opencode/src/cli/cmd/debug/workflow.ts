import { EOL } from "os"
import path from "path"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import type { WorktreeProvisioner } from "@opencode-ai/core/workflow/engine"
import { WorkflowEngine } from "@opencode-ai/core/workflow/engine"
import { effectCmd, fail } from "../../effect-cmd"

/**
 * Provisional workflow entry point for real live verification ahead of Phase 5's actual
 * `.opencode/workflows/` discovery + HTTP API. Runs a plain-JS file's source through
 * `WorkflowEngine.runSource` -- an isolated vm context with `agent`/`parallel`/`pipeline`/
 * `phase`/`log`/`budget`/`args` as bare globals (see WorkflowSandbox), matching the real
 * Workflow tool's contract -- not the host process's own global scope.
 *
 * Real `isolation: 'worktree'` support: adapts opencode's own Worktree.Service (app-layer --
 * depends on InstanceStore/Project/Git/AppProcess, which packages/core must not depend on) to
 * the engine's minimal WorktreeProvisioner port. Dynamically imported since it's only needed
 * when a script actually requests isolation.
 */
const makeWorktreeProvisioner = Effect.fn("Cli.debug.workflow.worktreeProvisioner")(function* () {
  const { Worktree } = yield* Effect.promise(() => import("@/worktree"))
  const worktree = yield* Worktree.Service
  return {
    create: (input) =>
      worktree.create({}).pipe(
        Effect.map((info) => ({
          directory: info.directory,
          cleanup: worktree.remove({ directory: info.directory }).pipe(Effect.asVoid, Effect.orDie),
        })),
      ),
  } satisfies WorktreeProvisioner
})

export const DebugWorkflowCommand = effectCmd({
  command: "workflow <file>",
  describe: "[provisional] run a workflow script (bare agent/parallel/pipeline/phase/log/budget/args globals) in a sandbox",
  builder: (yargs) =>
    yargs
      .positional("file", { describe: "path to a .js file -- its source runs with workflow globals, not module exports", type: "string" })
      .option("args", { describe: "JSON value exposed to the script as the bare `args` global", type: "string" })
      .option("budget", { describe: "USD budget cap for this run", type: "number" })
      .option("resume", { describe: "runID to resume (replays its journal; unchanged agent() calls are free)", type: "string" }),
  handler: (args) =>
    Effect.gen(function* () {
      const file = path.resolve(process.cwd(), args.file as string)
      const source = yield* Effect.promise(() => Bun.file(file).text())
      const parsedArgs = args.args ? yield* parseArgsJson(args.args) : undefined

      const worktree = yield* makeWorktreeProvisioner()
      const result = yield* WorkflowEngine.runSource({
        location: Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }),
        budgetUsd: args.budget ?? null,
        resumeFromRunId: args.resume,
        name: path.basename(file),
        onPhase: (title) => process.stdout.write(`\n== ${title} ==\n`),
        onLog: (message) => process.stdout.write(`${message}\n`),
        onRunID: (id) => process.stderr.write(`runID: ${id}\n`),
        worktree,
        source,
        args: parsedArgs,
      })
      process.stdout.write(JSON.stringify(result, null, 2) + EOL)
    }).pipe(
      Effect.catch((error) => fail(error instanceof Error ? error.message : String(error))),
      Effect.withSpan("Cli.debug.workflow"),
      Effect.provide(
        LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
      ),
      Effect.provide(
        AppNodeBuilder.build(SessionV2.node, [
          [LocationServiceMap.node, buildLocationServiceMap()],
          [SessionExecution.node, SessionExecutionLocal.node],
        ]),
      ),
      Effect.provide(buildLocationServiceMap()),
    ),
})

function parseArgsJson(raw: string) {
  const option = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(raw)
  return option._tag === "Some" ? Effect.succeed(option.value) : fail(`--args is not valid JSON: ${raw}`)
}

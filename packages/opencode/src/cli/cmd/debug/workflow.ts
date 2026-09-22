import { EOL } from "os"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap, buildLocationServiceMap } from "@opencode-ai/core/location-services"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { WorkflowEngine } from "@opencode-ai/core/workflow/engine"
import { effectCmd, fail } from "../../effect-cmd"

/**
 * Provisional workflow entry point for Phase 1 verification only. Loads a plain-JS file whose
 * default export is `async (ctx) => ...` and runs it through WorkflowEngine -- no sandboxing
 * (real `import()`, real global scope), no discovery/.opencode/workflows convention, no
 * persistence/resume/worktree isolation. Phase 4/5 replace this with the real sandboxed
 * bare-globals script format and .opencode/workflows/ discovery (see FORK_CHANGES.md).
 */
export const DebugWorkflowCommand = effectCmd({
  command: "workflow <file>",
  describe: "[provisional] run a workflow script's default-exported run(ctx) function",
  builder: (yargs) =>
    yargs
      .positional("file", { describe: "path to a .js/.ts file exporting default async (ctx) => ...", type: "string" })
      .option("args", { describe: "JSON value passed through as-is (unused by run(ctx) directly; thread it yourself)" })
      .option("budget", { describe: "USD budget cap for this run", type: "number" }),
  handler: (args) =>
    Effect.gen(function* () {
      const file = path.resolve(process.cwd(), args.file as string)
      const module = yield* Effect.promise(() => import(file))
      const script = module.default as (ctx: WorkflowEngine.Context) => Promise<unknown>
      if (typeof script !== "function") return yield* fail(`${file} has no default-exported function`)

      const result = yield* WorkflowEngine.run({
        location: Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) }),
        budgetUsd: args.budget ?? null,
        onPhase: (title) => process.stdout.write(`\n== ${title} ==\n`),
        onLog: (message) => process.stdout.write(`${message}\n`),
        run: script,
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

export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { BashTool } from "./bash"
import { ApplyPatchTool } from "./apply-patch"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { SkillTool } from "./skill"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todowrite"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { WriteTool } from "./write"

/**
 * Composes only the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools later use separate scoped canonical registrations, while
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared Location
 * services once to this merged set.
 *
 * TODO: Port the remaining launch-follow-up leaves deliberately: edit fuzzy
 * parity, LSP, repo_clone, repo_overview, plan_exit, and Rune/code mode. Keep
 * MCP and plugin transforms separate from this static built-in list.
 *
 * `task` depends on `SessionDispatchPort` (`../session/dispatch-port.ts`) rather than `SessionV2`
 * directly -- see that module's own doc comment for why a direct dependency here would close a
 * real cycle between session orchestration and this file's own location/tool bootstrap. The port
 * is an unbound node; its real implementation is supplied at the server's top-level composition
 * (`packages/opencode/src/server/routes/instance/httpapi/server.ts`), derived from the same
 * `SessionV2.node` build already composed there.
 */
export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.empty,
  deps: [
    ApplyPatchTool.node,
    BashTool.node,
    EditTool.node,
    GlobTool.node,
    GrepTool.node,
    QuestionTool.node,
    ReadTool.node,
    SkillTool.node,
    TaskTool.node,
    TodoWriteTool.node,
    WebFetchTool.node,
    WebSearchTool.node,
    WriteTool.node,
  ],
})

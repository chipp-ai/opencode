import { Workflow } from "@opencode-ai/schema/workflow"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export class WorkflowNotFoundError extends Schema.TaggedErrorClass<WorkflowNotFoundError>()(
  "WorkflowNotFoundError",
  {
    workflowID: Workflow.ID,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class WorkflowRunNotFoundError extends Schema.TaggedErrorClass<WorkflowRunNotFoundError>()(
  "WorkflowRunNotFoundError",
  {
    runID: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export const WorkflowGroup = HttpApiGroup.make("server.workflow")
  .add(
    HttpApiEndpoint.get("workflow.list", "/api/workflow", {
      query: LocationQuery,
      success: Location.response(Schema.Struct({ workflows: Schema.Array(Workflow.Info), errors: Schema.Array(Workflow.LintError) })),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.workflow.list",
          summary: "List workflows",
          description: "Discover .opencode/workflows/*.js scripts for a location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("workflow.run", "/api/workflow/:id/run", {
      params: { id: Workflow.ID },
      query: LocationQuery,
      payload: Schema.Struct({
        args: Schema.optional(Schema.Unknown),
        budgetUsd: Schema.optional(Schema.Number),
        resumeFromRunId: Schema.optional(Schema.String),
      }),
      success: Location.response(Workflow.Run),
      error: WorkflowNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.workflow.run",
          summary: "Run a workflow",
          description:
            "Runs a discovered workflow script to completion in a sandboxed vm context and returns its final result. Blocks for the run's full duration -- there is no streaming progress yet.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("workflow.run.get", "/api/workflow/run/:runID", {
      params: { runID: Schema.String },
      query: LocationQuery,
      success: Location.response(Workflow.Run),
      error: WorkflowRunNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.workflow.run.get",
          summary: "Get a workflow run",
          description: "Fetch a previously started run's status and result -- use its id as `resumeFromRunId` to replay it.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "workflows",
      description: "Experimental dynamic workflow routes.",
    }),
  )

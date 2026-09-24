export * as SessionRunnerStructuredOutput from "./structured-output"

import { Tool } from "@opencode-ai/llm"
import { Effect } from "effect"
import type { SessionMessage } from "../message"

export const NAME = "StructuredOutput"

export const SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the ${NAME} tool to provide your final response. Do NOT respond with plain text - you MUST call the ${NAME} tool with your answer formatted according to the schema.`

export const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Every tool except ${NAME} is disabled. Call the ${NAME} tool now with your best final answer based on the work done so far.`

const DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

/**
 * The format the runner must still satisfy: the newest user message's format, unless an assistant reply to that
 * message already captured structured output. A recorded failure does not count, so a later resume retries.
 */
export const pending = (context: ReadonlyArray<SessionMessage.Message>) => {
  const index = context.findLastIndex((message) => message.type === "user")
  const user = context[index]
  if (user?.type !== "user" || !user.format) return
  const satisfied = context
    .slice(index + 1)
    .some((message) => message.type === "assistant" && message.structured !== undefined)
  return satisfied ? undefined : user.format
}

/** Arguments are validated against `schema` before `execute`, so a violating call settles as a retryable tool error. */
export const make = (schema: Record<string, unknown>) => ({
  [NAME]: Tool.make({
    description: DESCRIPTION,
    // Providers reject or ignore a `$schema` dialect key inside tool input schemas.
    jsonSchema: Object.fromEntries(Object.entries(schema).filter((entry) => entry[0] !== "$schema")),
    execute: (params) => Effect.succeed(params),
    toModelOutput: () => [{ type: "text", text: "Structured output captured successfully." }],
  }),
})

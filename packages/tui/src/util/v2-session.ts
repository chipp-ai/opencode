import type {
  LlmToolContent,
  Message,
  ModelRef,
  Part,
  PermissionRequest,
  PermissionV2Request,
  PromptInput,
  Provider,
  QuestionRequest,
  QuestionV2Request,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionV2Info,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import type { PromptInfo } from "../prompt/history"
import { Locale } from "./locale"
import { name } from "./model"

/** Session palette commands that depend on V1-only endpoints or V1 message data, with no V2 path in the TUI yet. */
export const V2_UNAVAILABLE_COMMANDS = new Set(["session.timeline", "session.undo", "session.redo"])

export function v2UnavailableMessage(feature: string) {
  return `${feature} is not available in V2 mode yet`
}

/**
 * Sessions whose history lives in the legacy V1 message tables stay on the V1 view even when V2 mode
 * is enabled: the V2 runner only reads V2 history, so prompting them through V2 would silently drop
 * the existing transcript.
 */
export function isV2Session(input: { enabled: boolean; legacyMessageCount: number }) {
  return input.enabled && input.legacyMessageCount === 0
}

type Selection = Pick<SessionV2Info, "agent" | "model">

/** Agent/model switches needed so the durable V2 Session matches the TUI's current local selection. */
export function v2SwitchPlan(session: Selection, selected: { agent: string; model: ModelRef }) {
  return {
    agent: session.agent === selected.agent ? undefined : selected.agent,
    model: sameModel(session.model, selected.model) ? undefined : selected.model,
  }
}

// Mirrors SessionV2.switchModel's own no-op check, where an omitted variant means "default".
function sameModel(current: ModelRef | undefined, next: ModelRef) {
  return (
    current?.providerID === next.providerID &&
    current.id === next.id &&
    (current.variant ?? "default") === (next.variant ?? "default")
  )
}

/**
 * Context-window usage from the newest finished step that produced output, which is what the provider last
 * saw. `messages` is newest-first.
 */
export function v2ContextUsage(messages: SessionMessage[] = []) {
  const last = messages.find(
    (message): message is SessionMessageAssistant => message.type === "assistant" && (message.tokens?.output ?? 0) > 0,
  )
  if (!last?.tokens) return
  const tokens =
    last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
  if (tokens <= 0) return
  return { tokens, providerID: last.model.providerID, modelID: last.model.id }
}

export function toV2Prompt(text: string, parts: PromptInfo["parts"]): PromptInput {
  const files = parts.flatMap((part) =>
    part.type === "file"
      ? [
          {
            uri: part.url,
            name: part.filename,
            source: part.source
              ? { start: part.source.text.start, end: part.source.text.end, text: part.source.text.value }
              : undefined,
          },
        ]
      : [],
  )
  const agents = parts.flatMap((part) =>
    part.type === "agent"
      ? [
          {
            name: part.name,
            source: part.source ? { start: part.source.start, end: part.source.end, text: part.source.value } : undefined,
          },
        ]
      : [],
  )
  return {
    text,
    files: files.length > 0 ? files : undefined,
    agents: agents.length > 0 ? agents : undefined,
  }
}

export function toV1Permission(request: PermissionV2Request): PermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: request.action,
    patterns: request.resources,
    metadata: request.metadata ?? {},
    always: request.save ?? [],
    tool: request.source ? { messageID: request.source.messageID, callID: request.source.callID } : undefined,
  }
}

export function toV1Question(request: QuestionV2Request): QuestionRequest {
  return { id: request.id, sessionID: request.sessionID, questions: request.questions, tool: request.tool }
}

/**
 * Project a V2 transcript into the V1 message/part shapes the existing session renderers consume.
 * `messages` is newest-first, matching both `context/data.tsx` and the V2 messages endpoint. `agent`
 * and `model` seed the selection for user messages that precede any recorded switch or step.
 * Switches have no V1 shape, so they are returned separately, keyed by the id of the entry they follow
 * ("" before the first entry). Anchoring to the preceding entry keeps a marker in place when the
 * continuation that follows it arrives.
 */
export function toV1Transcript(input: {
  sessionID: string
  directory: string
  messages: SessionMessage[]
  agent?: string
  model?: ModelRef
}) {
  const selection: { agent: string; model?: ModelRef; parentID: string } = {
    agent: input.agent ?? "",
    model: input.model,
    parentID: "",
  }
  const switches: Record<string, V2Switch[]> = {}
  // Id of the most recent projected entry, which the next switch marker renders after.
  const anchor = { id: "" }
  const entries = input.messages.toReversed().flatMap((message): { info: Message; parts: Part[] }[] => {
    if (message.type === "agent-switched" || message.type === "model-switched") {
      if (message.type === "agent-switched") selection.agent = message.agent
      if (message.type === "model-switched") selection.model = message.model
      ;(switches[anchor.id] ??= []).push(message)
      return []
    }
    if (message.type === "assistant") {
      selection.agent = message.agent
      selection.model = message.model
      anchor.id = message.id
      return [assistantEntry(input, message, selection.parentID)]
    }
    if (message.type === "user") {
      selection.parentID = message.id
      anchor.id = message.id
      const base = { sessionID: input.sessionID, messageID: message.id }
      return [
        {
          info: userInfo(input.sessionID, message.id, message.time.created, selection),
          parts: [
            { ...base, id: `${message.id}-text`, type: "text", text: message.text },
            ...(message.files ?? []).map((file, index) => ({
              ...base,
              id: `${message.id}-file-${index}`,
              type: "file" as const,
              mime: file.mime,
              filename: file.name,
              url: file.uri,
            })),
            ...(message.agents ?? []).map((agent, index) => ({
              ...base,
              id: `${message.id}-agent-${index}`,
              type: "agent" as const,
              name: agent.name,
              source: agent.source
                ? { value: agent.source.text, start: agent.source.start, end: agent.source.end }
                : undefined,
            })),
          ],
        },
      ]
    }
    if (message.type === "compaction") {
      anchor.id = message.id
      return [
        {
          info: userInfo(input.sessionID, message.id, message.time.created, selection),
          parts: [
            {
              sessionID: input.sessionID,
              messageID: message.id,
              id: `${message.id}-compaction`,
              type: "compaction",
              auto: message.reason === "auto",
            },
          ],
        },
      ]
    }
    if (message.type === "shell") {
      anchor.id = message.id
      return [shellEntry(input, message, selection)]
    }
    // System context and synthetic reminders have no V1 transcript representation.
    return []
  })
  return {
    messages: entries.map((entry) => entry.info),
    parts: Object.fromEntries(entries.map((entry) => [entry.info.id, entry.parts])),
    switches,
  }
}

export type V2Switch = Extract<SessionMessage, { type: "model-switched" | "agent-switched" }>

/** Transcript and toast text for a durable agent/model switch, using the provider catalog's display name. */
export function switchLabel(item: V2Switch, providers: Provider[] | ReadonlyMap<string, Provider> | undefined) {
  if (item.type === "agent-switched") return `Switched to ${Locale.titlecase(item.agent)} agent`
  return `Switched to ${name(providers, item.model.providerID, item.model.id)}`
}

type SwitchObservation = { sessionID: string; id?: string; created?: number }

/**
 * Whether the newest switch just happened, rather than being history the TUI loaded. `previous` is
 * undefined while V2 history is still loading; a switch first seen then only counts as live if it was
 * created after the TUI opened the Session (`openedAt`), because a fallback on a new Session's first
 * turn can land before its history finishes loading. Afterwards, any new switch id is live.
 */
export function liveSwitch(
  previous: SwitchObservation | undefined,
  current: SwitchObservation | undefined,
  openedAt: number,
) {
  if (current?.id === undefined) return false
  if (previous === undefined || previous.sessionID !== current.sessionID)
    return current.created !== undefined && current.created >= openedAt
  return previous.id !== current.id
}

function userInfo(
  sessionID: string,
  id: string,
  created: number,
  selection: { agent: string; model?: ModelRef },
): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: selection.agent,
    model: {
      providerID: selection.model?.providerID ?? "",
      modelID: selection.model?.id ?? "",
      variant: selection.model?.variant,
    },
  }
}

function assistantEntry(
  input: { sessionID: string; directory: string },
  message: SessionMessageAssistant,
  parentID: string,
) {
  const base = { sessionID: input.sessionID, messageID: message.id }
  const info: Message = {
    id: message.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created: message.time.created, completed: message.time.completed },
    parentID,
    modelID: message.model.id,
    providerID: message.model.providerID,
    variant: message.model.variant,
    mode: message.agent,
    agent: message.agent,
    path: { cwd: input.directory, root: input.directory },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: message.finish,
    error: message.error ? { name: "UnknownError", data: { message: message.error.message } } : undefined,
  }
  const parts = message.content.map((item, index): Part => {
    if (item.type === "text") return { ...base, id: `${message.id}-${item.id}`, type: "text", text: item.text }
    if (item.type === "tool") return toolPart(base, item)
    // Reasoning has no explicit end event in the live bridge; later content or a finished step ends it.
    const ended = index < message.content.length - 1 || message.time.completed !== undefined
    return {
      ...base,
      id: `${message.id}-${item.id}`,
      type: "reasoning",
      text: item.text,
      metadata: item.providerMetadata,
      time: {
        start: item.time?.created ?? message.time.created,
        end: item.time?.completed ?? (ended ? (message.time.completed ?? message.time.created) : undefined),
      },
    }
  })
  return { info, parts }
}

// V2 records a user-typed shell command as its own message; the shared renderers show it the way V1 does,
// as an assistant turn holding a single bash tool call.
function shellEntry(
  input: { sessionID: string; directory: string },
  message: Extract<SessionMessage, { type: "shell" }>,
  selection: { agent: string; model?: ModelRef; parentID: string },
) {
  const base = { sessionID: input.sessionID, messageID: message.id }
  const info: Message = {
    id: message.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created: message.time.created, completed: message.time.completed },
    parentID: selection.parentID,
    modelID: selection.model?.id ?? "",
    providerID: selection.model?.providerID ?? "",
    mode: selection.agent,
    agent: selection.agent,
    path: { cwd: input.directory, root: input.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const shared = { ...base, id: `${message.id}-shell`, type: "tool" as const, callID: message.callID, tool: "bash" }
  const state = { input: { command: message.command }, metadata: { output: message.output } }
  const part: ToolPart =
    message.time.completed === undefined
      ? { ...shared, state: { status: "running", ...state, time: { start: message.time.created } } }
      : {
          ...shared,
          state: {
            status: "completed",
            ...state,
            output: message.output,
            title: message.command,
            time: { start: message.time.created, end: message.time.completed },
          },
        }
  return { info, parts: [part] }
}

function toolPart(base: { sessionID: string; messageID: string }, tool: SessionMessageAssistantTool): ToolPart {
  const shared = { ...base, id: `${base.messageID}-${tool.id}`, type: "tool" as const, callID: tool.id, tool: tool.name }
  const state = tool.state
  if (state.status === "pending") return { ...shared, state: { status: "pending", input: {}, raw: state.input } }
  const start = tool.time.ran ?? tool.time.created
  const input = toolInput(state.input)
  const metadata = toolMetadata(state.structured, state.content)
  if (state.status === "running") return { ...shared, state: { status: "running", input, metadata, time: { start } } }
  const time = { start, end: tool.time.completed ?? start }
  if (state.status === "error")
    return { ...shared, state: { status: "error", input, error: state.error.message, metadata, time } }
  return { ...shared, state: { status: "completed", input, output: metadata.output, title: "", metadata, time } }
}

// V2 file tools name their target `path`; the shared V1 renderers read `filePath`.
function toolInput(input: Record<string, unknown>) {
  if (input.filePath !== undefined || typeof input.path !== "string") return input
  return { ...input, filePath: input.path }
}

// The shared V1 renderers read tool results from metadata keys that V2 spreads across the
// model-facing `content` and the tool's `structured` output.
function toolMetadata(structured: Record<string, unknown>, content: LlmToolContent[]) {
  const patches = Array.isArray(structured.files)
    ? structured.files.flatMap((file) =>
        typeof file === "object" && file !== null && "patch" in file && typeof file.patch === "string"
          ? [file.patch]
          : [],
      )
    : []
  return {
    ...structured,
    output: content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
    sessionId: typeof structured.sessionID === "string" ? structured.sessionID : undefined,
    diff: patches.length > 0 ? patches.join("\n") : undefined,
  }
}

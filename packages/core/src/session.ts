export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Duration, Effect, Layer, Schema, Context, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ListAnchor } from "@opencode-ai/schema/session"
import { and, asc, desc, eq, gt, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionRollup } from "./session/rollup"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { SessionTitle } from "./session/title"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { Revert } from "@opencode-ai/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"
import { LLM, LLMClient } from "@opencode-ai/llm"
import { SessionCompaction } from "./session/compaction"
import { SessionHistory } from "./session/history"
import { SessionRunnerModel } from "./session/runner/model"
import { Config } from "./config"
import { llmClient } from "./effect/app-node-platform"
import { AppProcess } from "./process"
import { Shell } from "./shell"
import { Identifier } from "./id/id"
import { CommandV2 } from "./command"
import fuzzysort from "fuzzysort"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
  parentID?: SessionSchema.ID
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export class BusyError extends Schema.TaggedErrorClass<BusyError>()("Session.BusyError", {
  sessionID: SessionSchema.ID,
}) {}
export class InputNotPendingError extends Schema.TaggedErrorClass<InputNotPendingError>()(
  "Session.InputNotPendingError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export class CommandNotFoundError extends Schema.TaggedErrorClass<CommandNotFoundError>()(
  "Session.CommandNotFoundError",
  {
    command: Schema.String,
    available: Schema.Array(Schema.String),
  },
) {
  override get message() {
    return `Command not found: "${this.command}".${suggest(this.command, this.available, "commands")}`
  }
}

export class AgentNotFoundError extends Schema.TaggedErrorClass<AgentNotFoundError>()("Session.AgentNotFoundError", {
  agent: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Agent not found: "${this.agent}".${suggest(this.agent, this.available, "agents")}`
  }
}

const suggest = (name: string, available: ReadonlyArray<string>, kind: string) => {
  if (available.length === 0) return ""
  const close = fuzzysort.go(name, [...available], { limit: 3 }).map((match) => match.target)
  if (close.length > 0) return ` Did you mean: ${close.join(", ")}?`
  return ` Available ${kind}: ${available.join(", ")}`
}

export type CommandResult =
  | { readonly type: "prompt"; readonly input: SessionInput.Admitted }
  | {
      readonly type: "subtask"
      readonly sessionID: SessionSchema.ID
      readonly text: string
      readonly error?: string
    }

export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | InputNotPendingError
  | BusyError
  | CommandNotFoundError
  | AgentNotFoundError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly cost: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Rollup, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: string }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  /** Admitted inputs not yet promoted into visible messages, in promotion order. */
  readonly pending: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInput.Admitted[], NotFoundError>
  /** Withdraws one admitted input before promotion so it never runs. */
  readonly withdraw: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<void, NotFoundError | InputNotPendingError>
  /** Replaces the prompt of one admitted input before promotion, keeping its delivery and position. */
  readonly revise: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
    prompt: PromptInput.Prompt
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | InputNotPendingError>
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | BusyError>
  /**
   * Runs a registered slash command: expands its template, then either prompts this Session with the command's
   * agent/model applied to that one prompt only, or dispatches a subagent and records its result here.
   */
  readonly command: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    command: string
    arguments?: string
    /** The caller's current agent, used when the command names none. */
    agent?: AgentV2.ID
    /** The caller's current model, used when neither the command nor its agent names one. */
    model?: ModelV2.Ref
    files?: PromptInput.Prompt["files"]
    delivery?: SessionInput.Delivery
  }) => Effect.Effect<
    CommandResult,
    | NotFoundError
    | PromptConflictError
    | CommandNotFoundError
    | AgentNotFoundError
    | SessionRunnerModel.Error
    | SessionRunner.RunError
  >
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const llm = yield* LLMClient.Service
    const appProcess = yield* AppProcess.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionV1.SessionInfo.make({
          id: sessionID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: input.location.directory,
          path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
          workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
          title: SessionTitle.placeholder(now),
          agent: input.agent,
          parentID: input.parentID,
          model: input.model
            ? {
                id: ModelV2.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        const projected = yield* events
          .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      cost: Effect.fn("V2Session.cost")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        const rows = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.project_id, session.projectID))
          .all()
          .pipe(Effect.orDie)
        return SessionRollup.rollup(rows.map((row) => fromRow(row)), sessionID)
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            const prompt = resolvePrompt(input.prompt)
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const expected = { sessionID: input.sessionID, messageID, prompt, delivery }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt,
              delivery,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            // A withdrawn ID stays reserved so a late retry cannot resurrect input the user removed.
            if (admitted.withdrawnSeq !== undefined || !SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (input.resume !== false) yield* execution.wake(admitted.sessionID)
            return admitted
          }),
        ),
      ),
      pending: Effect.fn("V2Session.pending")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* SessionInput.listPending(db, sessionID)
      }),
      withdraw: Effect.fn("V2Session.withdraw")(function* (input) {
        yield* result.get(input.sessionID)
        yield* SessionInput.withdraw(events, { id: input.messageID, sessionID: input.sessionID }).pipe(
          Effect.catchTag(
            "SessionInput.NotPending",
            () => new InputNotPendingError({ sessionID: input.sessionID, messageID: input.messageID }),
          ),
        )
      }),
      revise: Effect.fn("V2Session.revise")(function* (input) {
        yield* result.get(input.sessionID)
        yield* SessionInput.revise(events, {
          id: input.messageID,
          sessionID: input.sessionID,
          prompt: resolvePrompt(input.prompt),
        }).pipe(
          Effect.catchTag(
            "SessionInput.NotPending",
            () => new InputNotPendingError({ sessionID: input.sessionID, messageID: input.messageID }),
          ),
        )
        const revised = yield* SessionInput.find(db, input.messageID)
        if (!revised) return yield* Effect.die("Revised session input is missing")
        return revised
      }),
      // A user-typed command: no model call and no permission gate, since the human is the caller.
      shell: Effect.fn("V2Session.shell")(function* (input) {
        const session = yield* result.get(input.sessionID)
        // Only rejects an already-running drain; input admitted during the command may still start one.
        if ((yield* execution.active).has(session.id)) return yield* new BusyError({ sessionID: session.id })
        const shell = yield* Effect.gen(function* () {
          const config = yield* Config.Service
          return Shell.preferred(Config.latest(yield* config.entries(), "shell"))
        }).pipe(Effect.provide(locations.get(session.location)), Effect.orDie)
        const callID = Identifier.create("shell", "ascending")
        yield* events.publish(
          SessionEvent.Shell.Started,
          {
            sessionID: session.id,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            callID,
            command: input.command,
          },
          { id: input.id },
        )
        const end = (output: string) =>
          Effect.gen(function* () {
            yield* events.publish(SessionEvent.Shell.Ended, {
              sessionID: session.id,
              timestamp: yield* DateTime.now,
              callID,
              output,
            })
          })
        const output = yield* runShell(appProcess, shell, input.command, session.location.directory).pipe(
          Effect.onInterrupt(() => end("[command interrupted]")),
        )
        yield* end(output)
        if (input.resume !== true) return
        // `wake` only drains pending input, so answering the shell output needs a forced run. Detached so
        // the caller is not held for the model turn; the drain is registered before this returns, and
        // its failures are already logged by the execution owner.
        yield* execution.resume(session.id).pipe(Effect.ignore, Effect.forkDetach({ startImmediately: true }))
      }),
      command: Effect.fn("V2Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* Effect.gen(function* () {
          const commands = yield* CommandV2.Service
          const agents = yield* AgentV2.Service
          const models = yield* SessionRunnerModel.Service
          const config = yield* Config.Service
          const command = yield* commands.get(input.command)
          if (!command)
            return yield* new CommandNotFoundError({
              command: input.command,
              available: (yield* commands.list()).map((item) => item.name),
            })
          const requested = command.agent ?? input.agent
          const agent = yield* agents.select(requested ?? session.agent)
          if (requested && !agent.info)
            return yield* new AgentNotFoundError({
              agent: requested,
              available: (yield* agents.all()).filter((item) => !item.hidden).map((item) => item.id),
            })
          // Matches V1: an agent's own model only wins when the command itself names that agent.
          const model =
            command.model ?? (command.agent ? agent.info?.model : undefined) ?? input.model ?? session.model
          // Fail before anything durable is recorded rather than on the first provider turn.
          if (model) yield* models.resolve({ ...session, model })
          const rendered = CommandV2.render(command.template, input.arguments ?? "")
          // Expanded after argument substitution, as in V1, so a marker may use `$1`. The caller is the human
          // typing the command, the same trust boundary as `shell`.
          const markers = Array.from(rendered.matchAll(CommandV2.SHELL_PATTERN), (match) => match[1])
          const shell =
            markers.length === 0 ? undefined : Shell.preferred(Config.latest(yield* config.entries(), "shell"))
          const outputs = shell
            ? yield* Effect.forEach(
                markers,
                (marker) => runShell(appProcess, shell, marker, session.location.directory),
                { concurrency: "unbounded" },
              )
            : []
          const text = rendered.replace(CommandV2.SHELL_PATTERN, () => outputs.shift() ?? "").trim()
          const subtask = (agent.info?.mode === "subagent" && command.subtask !== false) || command.subtask === true
          if (!subtask) {
            const sessionAgent = yield* agents.select(session.agent)
            const admitted = yield* result.prompt({
              id: input.id,
              sessionID: session.id,
              delivery: input.delivery,
              prompt: {
                text,
                files: input.files,
                ...(agent.id === sessionAgent.id ? {} : { agentOverride: agent.id }),
                ...(model === undefined || sameModel(model, session.model) ? {} : { modelOverride: model }),
              },
            })
            return { type: "prompt" as const, input: admitted }
          }
          // Dynamic: agent-dispatch imports this module, and a subtask dispatch is the only path that needs it.
          const { WorkflowAgentDispatch } = yield* Effect.promise(() => import("./workflow/agent-dispatch"))
          const dispatched = yield* WorkflowAgentDispatch.run({
            location: session.location,
            parentSessionID: session.id,
            model,
            persona: agent.info?.system ?? "",
            permissions: agent.info?.permissions,
            steps: agent.info?.steps,
            prompt: { text, files: input.files },
          }).pipe(
            Effect.provideService(Service, result),
            Effect.provideService(Database.Service, database),
            // Only the structured-output tool registration fails this way, and no structured output is requested.
            Effect.catchTag("Tool.RegistrationError", Effect.die),
          )
          const error = dispatched.error?.message
          // Matches V1: the parent records the subagent's answer, then continues on its own agent and model.
          yield* events.publish(SessionEvent.Synthetic, {
            sessionID: session.id,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            text: [
              `The /${command.name} command ran in subagent session ${dispatched.sessionID}.`,
              "",
              `<task id="${dispatched.sessionID}">`,
              error ? `Subagent failed: ${error}` : dispatched.text,
              "</task>",
              "",
              "Summarize the task tool output above and continue with your task.",
            ].join("\n"),
          })
          yield* execution.resume(session.id).pipe(Effect.ignore, Effect.forkDetach({ startImmediately: true }))
          return {
            type: "subtask" as const,
            sessionID: dispatched.sessionID,
            text: dispatched.text,
            ...(error === undefined ? {} : { error }),
          }
        }).pipe(Effect.provide(locations.get(session.location).pipe(Layer.orDie)))
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (sameModel(input.model, session.model)) return
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        const session = yield* result.get(input.sessionID)
        yield* Effect.gen(function* () {
          const models = yield* SessionRunnerModel.Service
          const config = yield* Config.Service
          const resolved = yield* models.resolve(session)
          const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
          // Manual compaction skips the auto/threshold gate; compaction only reads `http` and
          // `generation` from the request, so no turn-shaped system/messages/tools are needed.
          yield* compaction.compactAfterOverflow(
            {
              sessionID: session.id,
              entries: yield* SessionHistory.entriesForRunner(db, session.id, 0),
              model: resolved.model,
              request: LLM.request({
                model: resolved.model,
                http: { headers: { "x-session-affinity": session.id, "X-Session-Id": session.id } },
              }),
            },
            "manual",
          )
        }).pipe(Effect.provide(locations.get(session.location)), Effect.orDie)
        yield* execution.wake(session.id)
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        // Joins this process's current drain for the Session (if any), never forces a new one.
        // Safe to call right after `prompt`, since `execution.wake` has already registered the
        // drain by the time `prompt` returns.
        yield* execution.join(sessionID)
      }),
      active: execution.active,
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(execution.interrupt(sessionID)),
      ),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
        }),
      },
    })

    return result
  }),
)

// Matches the bash tool's capture ceiling and maximum timeout; a typed command has no per-call timeout.
const SHELL_TIMEOUT = Duration.minutes(10)
const SHELL_MAX_OUTPUT_BYTES = 1024 * 1024

const runShell = (appProcess: AppProcess.Interface, shell: string, command: string, cwd: string) =>
  appProcess
    .run(
      ChildProcess.make(shell, Shell.args(shell, command, cwd), {
        cwd,
        extendEnv: true,
        env: { TERM: "dumb" },
        stdin: "ignore",
        detached: process.platform !== "win32",
        forceKillAfter: Duration.seconds(3),
      }),
      { combineOutput: true, timeout: SHELL_TIMEOUT, maxOutputBytes: SHELL_MAX_OUTPUT_BYTES },
    )
    .pipe(
      Effect.map((result) => {
        const output = result.output?.toString("utf8") ?? ""
        if (!result.outputTruncated) return output
        return `${output}\n\n[output capture truncated at the in-memory safety limit]`
      }),
      // Spawn failures and timeouts become the recorded output so the shell message always completes.
      Effect.catchTag("AppProcessError", (error) =>
        Effect.succeed(
          error.cause instanceof Error && error.cause.message === "Timed out"
            ? `Command exceeded timeout of ${Duration.toMillis(SHELL_TIMEOUT)} ms.`
            : error.message,
        ),
      ),
    )

const sameModel = (model: ModelV2.Ref, current: ModelV2.Ref | undefined) =>
  current?.providerID === model.providerID &&
  current.id === model.id &&
  (current.variant ?? "default") === (model.variant ?? "default")

const resolvePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    agents: input.agents,
    format: input.format,
    agentOverride: input.agentOverride,
    modelOverride: input.modelOverride,
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
      }
    }),
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
    llmClient,
    AppProcess.node,
  ],
})

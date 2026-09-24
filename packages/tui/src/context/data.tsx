import type {
  AgentV2Info,
  CommandV2Info,
  IntegrationInfo,
  LocationRef,
  ModelV2Info,
  PermissionSavedInfo,
  PermissionV2Request,
  ProviderV2Info,
  QuestionV2Request,
  ReferenceInfo,
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionInputAdmitted,
  SessionRollup,
  SessionStatus,
  SessionV2Info,
  SkillV2Info,
  V2Event,
} from "@opencode-ai/sdk/v2"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useEvent } from "./event"
import { usePermission } from "./permission"
import { createSignal, onCleanup, onMount } from "solid-js"

type LocationData = {
  agent?: AgentV2Info[]
  command?: CommandV2Info[]
  integration?: IntegrationInfo[]
  model?: ModelV2Info[]
  provider?: ProviderV2Info[]
  reference?: ReferenceInfo[]
  skill?: SkillV2Info[]
}

type Data = {
  session: {
    info: Record<string, SessionV2Info>
    cost: Record<string, SessionRollup>
    message: Record<string, SessionMessage[]>
    /** Cursor for the next older page of `message`, when one may exist. */
    older: Record<string, string | undefined>
    input: Record<string, SessionInputAdmitted[]>
    permission: Record<string, PermissionV2Request[]>
    question: Record<string, QuestionV2Request[]>
    /** Live execution status pushed by the server; absent until the first event or refresh. */
    status: Record<string, SessionStatus>
  }
  project: {
    permission: Record<string, PermissionSavedInfo[]>
  }
  location: Record<string, LocationData>
}

function locationKey(location: LocationRef) {
  return JSON.stringify([location.directory, location.workspaceID])
}

const MESSAGE_PAGE = 200

// The endpoint returns a `next` cursor for any non-empty page, so a short page is the only end-of-history signal.
function olderCursor(page: { data: unknown[]; cursor: { next?: string } }) {
  return page.data.length < MESSAGE_PAGE ? undefined : page.cursor.next
}

function locationQuery(ref?: LocationRef) {
  return ref ? { directory: ref.directory, workspace: ref.workspaceID } : undefined
}

export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: () => {
    const [store, setStore] = createStore<Data>({
      session: {
        info: {},
        cost: {},
        message: {},
        older: {},
        input: {},
        permission: {},
        question: {},
        status: {},
      },
      project: {
        permission: {},
      },
      location: {},
    })

    const sdk = useSDK()
    const events = useEvent()
    const permissionMode = usePermission()
    const [defaultLocation, setDefaultLocation] = createSignal<LocationRef>({
      directory: sdk.directory ?? process.cwd(),
    })

    const message = {
      update(sessionID: string, fn: (messages: SessionMessage[]) => void) {
        setStore(
          "session",
          "message",
          produce((draft) => {
            fn((draft[sessionID] ??= []))
          }),
        )
      },
      prepend(messages: SessionMessage[], item: SessionMessage) {
        if (messages.some((existing) => existing.id === item.id)) return
        messages.unshift(item)
      },
      activeAssistant(messages: SessionMessage[]) {
        const item = messages.find((item) => item.type === "assistant" && !item.time.completed)
        return item?.type === "assistant" ? item : undefined
      },
      assistant(messages: SessionMessage[], messageID: string) {
        const item = messages.find((item) => item.type === "assistant" && item.id === messageID)
        return item?.type === "assistant" ? item : undefined
      },
      activeShell(messages: SessionMessage[], callID: string) {
        const item = messages.find((item) => item.type === "shell" && item.callID === callID)
        return item?.type === "shell" ? item : undefined
      },
      latestTool(assistant: SessionMessageAssistant | undefined, callID?: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantTool =>
            item.type === "tool" && (callID === undefined || item.id === callID),
        )
      },
      latestText(assistant: SessionMessageAssistant | undefined, textID: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantText => item.type === "text" && item.id === textID,
        )
      },
      latestReasoning(assistant: SessionMessageAssistant | undefined, reasoningID: string) {
        return assistant?.content.findLast(
          (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && item.id === reasoningID,
        )
      },
    }

    function removeInput(sessionID: string, messageID: string) {
      if (!store.session.input[sessionID]?.some((input) => input.id === messageID)) return
      setStore("session", "input", sessionID, (inputs) => inputs.filter((input) => input.id !== messageID))
    }

    // A snapshot fetched while a step was starting can miss its step.started event; once that step
    // settles, reload the loaded transcript rather than leaving the turn invisible.
    function resyncMissingAssistant(sessionID: string, assistantMessageID: string) {
      const messages = store.session.message[sessionID]
      if (!messages || messages.some((item) => item.id === assistantMessageID)) return
      void result.session.message.refresh(sessionID)
    }

    function removeRequest(kind: "permission" | "question", sessionID: string, requestID: string) {
      setStore(
        "session",
        kind,
        produce((draft) => {
          const requests = draft[sessionID]
          const index = requests?.findIndex((request) => request.id === requestID) ?? -1
          if (index !== -1) requests.splice(index, 1)
        }),
      )
    }

    async function reseedStatus() {
      const known = Object.keys(store.session.status)
      if (known.length === 0) return
      const result = await sdk.client.v2.session.active({ throwOnError: true })
      setStore(
        "session",
        "status",
        produce((draft) => {
          for (const sessionID of known)
            draft[sessionID] = { type: result.data.data[sessionID] === undefined ? "idle" : "busy" }
        }),
      )
    }

    function handleEvent(event: V2Event) {
      switch (event.type) {
        case "catalog.updated":
          void Promise.all([
            result.location.model.refresh(event.location),
            result.location.provider.refresh(event.location),
          ])
          break
        case "session.next.agent.switched":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "agent", event.data.agent)
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "agent-switched",
              agent: event.data.agent,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.model.switched":
          if (store.session.info[event.data.sessionID])
            setStore("session", "info", event.data.sessionID, "model", event.data.model)
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "model-switched",
              model: event.data.model,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.turn.failed":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "turn-failed",
              error: event.data.error,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.prompted": {
          removeInput(event.data.sessionID, event.data.messageID)
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "user",
              text: event.data.prompt.text,
              files: event.data.prompt.files,
              agents: event.data.prompt.agents,
              time: { created: event.data.timestamp },
            })
          })
          break
        }
        case "session.next.prompt.admitted":
          setStore(
            "session",
            "input",
            produce((draft) => {
              const inputs = (draft[event.data.sessionID] ??= [])
              if (inputs.some((input) => input.id === event.data.messageID)) return
              inputs.push({
                admittedSeq: event.durable?.seq ?? Number.MAX_SAFE_INTEGER,
                id: event.data.messageID,
                sessionID: event.data.sessionID,
                prompt: event.data.prompt,
                delivery: event.data.delivery,
                timeCreated: event.data.timestamp,
              })
            }),
          )
          break
        case "session.next.prompt.withdrawn":
          removeInput(event.data.sessionID, event.data.messageID)
          break
        case "session.next.prompt.revised":
          setStore(
            "session",
            "input",
            event.data.sessionID,
            (input) => input.id === event.data.messageID,
            "prompt",
            event.data.prompt,
          )
          break
        case "session.next.context.updated":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "system",
              text: event.data.text,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.synthetic":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "synthetic",
              sessionID: event.data.sessionID,
              text: event.data.text,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.message.forked":
          message.update(event.data.sessionID, (draft) => message.prepend(draft, event.data.message))
          break
        case "session.next.shell.started":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "shell",
              callID: event.data.callID,
              command: event.data.command,
              output: "",
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.shell.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.activeShell(draft, event.data.callID)
            if (!match) return
            match.output = event.data.output
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.step.started":
          message.update(event.data.sessionID, (draft) => {
            if (draft.some((message) => message.id === event.data.assistantMessageID)) return
            const currentAssistant = message.activeAssistant(draft)
            if (currentAssistant) currentAssistant.time.completed = event.data.timestamp
            message.prepend(draft, {
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "session.next.step.ended":
          resyncMissingAssistant(event.data.sessionID, event.data.assistantMessageID)
          // A step in any session may belong to a tracked session's subagent tree, and the event does not say
          // which, so reload every rollup being displayed.
          for (const sessionID of Object.keys(store.session.cost))
            void result.session.cost.refresh(sessionID).catch(() => {})
          message.update(event.data.sessionID, (draft) => {
            const currentAssistant = message.assistant(draft, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.data.timestamp
            currentAssistant.finish = event.data.finish
            currentAssistant.cost = event.data.cost
            currentAssistant.tokens = event.data.tokens
            if (event.data.snapshot)
              currentAssistant.snapshot = { ...currentAssistant.snapshot, end: event.data.snapshot }
          })
          break
        case "session.next.step.failed":
          resyncMissingAssistant(event.data.sessionID, event.data.assistantMessageID)
          message.update(event.data.sessionID, (draft) => {
            const currentAssistant = message.assistant(draft, event.data.assistantMessageID)
            if (!currentAssistant) return
            currentAssistant.time.completed = event.data.timestamp
            currentAssistant.finish = "error"
            currentAssistant.error = event.data.error
          })
          break
        case "session.next.text.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "text",
              id: event.data.textID,
              text: "",
            })
          })
          break
        case "session.next.text.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestText(message.assistant(draft, event.data.assistantMessageID), event.data.textID)
            if (match) match.text += event.data.delta
          })
          break
        case "session.next.text.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestText(message.assistant(draft, event.data.assistantMessageID), event.data.textID)
            if (match) match.text = event.data.text
          })
          break
        case "session.next.tool.input.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "tool",
              id: event.data.callID,
              name: event.data.name,
              time: { created: event.data.timestamp },
              state: { status: "pending", input: "" },
            })
          })
          break
        case "session.next.tool.input.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status === "pending") match.state.input += event.data.delta
          })
          break
        case "session.next.tool.input.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status === "pending") match.state.input = event.data.text
          })
          break
        case "session.next.tool.called":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (!match) return
            match.time.ran = event.data.timestamp
            match.provider = event.data.provider
            match.state = { status: "running", input: event.data.input, structured: {}, content: [] }
          })
          break
        case "session.next.tool.progress":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status !== "running") return
            match.state.structured = event.data.structured
            match.state.content = [...event.data.content]
          })
          break
        case "session.next.tool.success":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (match?.state.status !== "running") return
            match.state = {
              status: "completed",
              input: match.state.input,
              structured: event.data.structured,
              content: [...event.data.content],
              result: event.data.result,
            }
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.tool.failed":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestTool(message.assistant(draft, event.data.assistantMessageID), event.data.callID)
            if (!match || (match.state.status !== "pending" && match.state.status !== "running")) return
            match.state = {
              status: "error",
              error: event.data.error,
              input: typeof match.state.input === "string" ? {} : match.state.input,
              structured: match.state.status === "running" ? match.state.structured : {},
              content: match.state.status === "running" ? match.state.content : [],
              result: event.data.result,
            }
            match.provider = {
              executed: event.data.provider.executed || match.provider?.executed === true,
              metadata: match.provider?.metadata,
              resultMetadata: event.data.provider.metadata,
            }
            match.time.completed = event.data.timestamp
          })
          break
        case "session.next.reasoning.started":
          message.update(event.data.sessionID, (draft) => {
            message.assistant(draft, event.data.assistantMessageID)?.content.push({
              type: "reasoning",
              id: event.data.reasoningID,
              text: "",
              providerMetadata: event.data.providerMetadata,
            })
          })
          break
        case "session.next.reasoning.delta":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestReasoning(
              message.assistant(draft, event.data.assistantMessageID),
              event.data.reasoningID,
            )
            if (match) match.text += event.data.delta
          })
          break
        case "session.next.reasoning.ended":
          message.update(event.data.sessionID, (draft) => {
            const match = message.latestReasoning(
              message.assistant(draft, event.data.assistantMessageID),
              event.data.reasoningID,
            )
            if (match) {
              match.text = event.data.text
              if (event.data.providerMetadata !== undefined) match.providerMetadata = event.data.providerMetadata
            }
          })
          break
        case "session.next.status.changed":
          setStore("session", "status", event.data.sessionID, { type: event.data.status })
          break
        case "server.connected":
          // Status events are live-only, so any sent while disconnected are lost; reseed every known session.
          void reseedStatus().catch((error) => console.error("Failed to reseed session status", error))
          break
        case "session.next.retried":
        case "session.next.compaction.started":
        case "session.next.compaction.delta":
          break
        case "session.next.compaction.ended":
          message.update(event.data.sessionID, (draft) => {
            message.prepend(draft, {
              id: event.data.messageID,
              type: "compaction",
              reason: event.data.reason,
              summary: event.data.text,
              recent: event.data.recent,
              time: { created: event.data.timestamp },
            })
          })
          break
        case "permission.v2.asked":
          // `--auto` approves every V2 request this process sees, whichever session is open, like V1's sync store.
          if (permissionMode.mode === "auto") {
            void sdk.client.v2.session.permission
              .reply({ sessionID: event.data.sessionID, requestID: event.data.id, reply: "once" })
              .catch((error) => console.error("Failed to auto-approve permission", error))
            break
          }
          // Subagent sessions are created server-side; load their info so parents can claim their requests.
          if (!store.session.info[event.data.sessionID]) void result.session.refresh(event.data.sessionID)
          setStore(
            "session",
            "permission",
            produce((draft) => {
              const requests = (draft[event.data.sessionID] ??= [])
              if (requests.some((request) => request.id === event.data.id)) return
              requests.push(event.data)
            }),
          )
          break
        case "permission.v2.replied":
          removeRequest("permission", event.data.sessionID, event.data.requestID)
          break
        case "question.v2.asked":
          if (!store.session.info[event.data.sessionID]) void result.session.refresh(event.data.sessionID)
          setStore(
            "session",
            "question",
            produce((draft) => {
              const requests = (draft[event.data.sessionID] ??= [])
              if (requests.some((request) => request.id === event.data.id)) return
              requests.push(event.data)
            }),
          )
          break
        case "question.v2.replied":
        case "question.v2.rejected":
          removeRequest("question", event.data.sessionID, event.data.requestID)
          break
        case "reference.updated":
          void result.location.reference.refresh()
          break
        case "integration.updated":
          void Promise.all([
            result.location.integration.refresh(event.location),
            result.location.model.refresh(event.location),
            result.location.provider.refresh(event.location),
          ])
          break
      }
    }

    onMount(() => {
      const unsub = events.subscribe((event, metadata) => {
        handleEvent({
          ...event,
          data: event.properties,
          location: { directory: metadata.directory, workspaceID: metadata.workspace },
        } as V2Event)
      })
      onCleanup(unsub)
    })

    const result = {
      session: {
        get(sessionID: string) {
          return store.session.info[sessionID]
        },
        async refresh(sessionID: string) {
          const result = await sdk.client.v2.session.get({ sessionID }, { throwOnError: true })
          setStore("session", "info", sessionID, result.data.data)
        },
        cost: {
          /** The session's own spend plus its subagent tree's, once loaded; kept current as steps end. */
          get(sessionID: string) {
            return store.session.cost[sessionID]
          },
          async refresh(sessionID: string) {
            const result = await sdk.client.v2.session.cost({ sessionID }, { throwOnError: true })
            setStore("session", "cost", sessionID, result.data.data)
          },
        },
        message: {
          list(sessionID: string) {
            return store.session.message[sessionID]
          },
          async refresh(sessionID: string) {
            // Newest-first like the live bridge; 200 is the endpoint's maximum page size.
            const result = await sdk.client.v2.session.messages(
              { sessionID, limit: MESSAGE_PAGE },
              { throwOnError: true },
            )
            setStore("session", "message", sessionID, result.data.data)
            setStore("session", "older", sessionID, olderCursor(result.data))
          },
          /** Whether an older page may exist beyond the loaded messages. */
          hasOlder(sessionID: string) {
            return store.session.older[sessionID] !== undefined
          },
          /** Appends the next page of older messages, keeping the list newest-first. */
          async loadOlder(sessionID: string) {
            const cursor = store.session.older[sessionID]
            if (!cursor) return
            const result = await sdk.client.v2.session.messages(
              { sessionID, limit: MESSAGE_PAGE, cursor },
              { throwOnError: true },
            )
            message.update(sessionID, (draft) => {
              const known = new Set(draft.map((item) => item.id))
              draft.push(...result.data.data.filter((item) => !known.has(item.id)))
            })
            setStore("session", "older", sessionID, olderCursor(result.data))
          },
        },
        input: {
          /** Admitted inputs not yet promoted into visible messages, in promotion order. */
          list(sessionID: string) {
            return store.session.input[sessionID]
          },
          async refresh(sessionID: string) {
            const result = await sdk.client.v2.session.input.list({ sessionID }, { throwOnError: true })
            setStore("session", "input", sessionID, result.data.data)
          },
          async withdraw(sessionID: string, messageID: string) {
            await sdk.client.v2.session.input.withdraw({ sessionID, messageID }, { throwOnError: true })
            removeInput(sessionID, messageID)
          },
          async revise(sessionID: string, messageID: string, prompt: SessionInputAdmitted["prompt"]) {
            const result = await sdk.client.v2.session.input.revise(
              {
                sessionID,
                messageID,
                prompt: {
                  text: prompt.text,
                  files: prompt.files?.map((file) => ({
                    uri: file.uri,
                    name: file.name,
                    description: file.description,
                    source: file.source,
                  })),
                  agents: prompt.agents,
                },
              },
              { throwOnError: true },
            )
            setStore("session", "input", sessionID, (input) => input.id === messageID, result.data.data)
          },
        },
        permission: {
          list(sessionID: string) {
            return store.session.permission[sessionID]
          },
          /** Pending requests for a session and its direct subagent sessions. */
          tree(sessionID: string) {
            return Object.values(store.session.permission)
              .flat()
              .filter(
                (request) =>
                  request.sessionID === sessionID || store.session.info[request.sessionID]?.parentID === sessionID,
              )
          },
          async refresh(sessionID: string) {
            const result = await sdk.client.v2.session.permission.list({ sessionID }, { throwOnError: true })
            setStore("session", "permission", sessionID, result.data.data)
          },
        },
        status: {
          get(sessionID: string): SessionStatus {
            return store.session.status[sessionID] ?? { type: "idle" }
          },
          /**
           * Seeds status for a session attached mid-run, before this process has seen any status event for it.
           * A pushed value always wins, so a snapshot that raced a newer event cannot overwrite it.
           */
          async refresh(sessionID: string) {
            const result = await sdk.client.v2.session.active({ throwOnError: true })
            if (store.session.status[sessionID]) return
            setStore("session", "status", sessionID, {
              type: result.data.data[sessionID] === undefined ? "idle" : "busy",
            })
          },
        },
        question: {
          list(sessionID: string) {
            return store.session.question[sessionID]
          },
          /** Pending requests for a session and its direct subagent sessions. */
          tree(sessionID: string) {
            return Object.values(store.session.question)
              .flat()
              .filter(
                (request) =>
                  request.sessionID === sessionID || store.session.info[request.sessionID]?.parentID === sessionID,
              )
          },
          async refresh(sessionID: string) {
            const result = await sdk.client.v2.session.question.list({ sessionID }, { throwOnError: true })
            setStore("session", "question", sessionID, result.data.data)
          },
        },
      },
      project: {
        permission: {
          list(projectID: string) {
            return store.project.permission[projectID]
          },
          async refresh(projectID: string) {
            const result = await sdk.client.v2.permission.saved.list({ projectID }, { throwOnError: true })
            setStore("project", "permission", projectID, result.data.data)
          },
        },
      },
      location: {
        default() {
          return defaultLocation()
        },
        async refresh(ref?: LocationRef) {
          const response = await sdk.client.v2.location.get({ location: locationQuery(ref) }, { throwOnError: true })
          const location = response.data
          const key = locationKey(location)
          if (!store.location[key]) setStore("location", key, {})
          if (!ref) setDefaultLocation({ directory: location.directory, workspaceID: location.workspaceID })
        },
        agent: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.agent
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.agent.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "agent", result.data.data)
          },
        },
        command: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.command
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.command.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "command", result.data.data)
          },
        },
        integration: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.integration
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.integration.list(
              { location: locationQuery(ref) },
              { throwOnError: true },
            )
            const key = locationKey(result.data.location)
            setStore("location", key, "integration", result.data.data)
          },
        },
        model: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.model
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.model.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "model", result.data.data)
          },
        },
        provider: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.provider
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.provider.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "provider", result.data.data)
          },
        },
        reference: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.reference
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.reference.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "reference", result.data.data)
          },
        },
        skill: {
          list(location?: LocationRef) {
            return store.location[locationKey(location ?? defaultLocation())]?.skill
          },
          async refresh(ref?: LocationRef) {
            const result = await sdk.client.v2.skill.list({ location: locationQuery(ref) }, { throwOnError: true })
            const key = locationKey(result.data.location)
            setStore("location", key, "skill", result.data.data)
          },
        },
      },
    }

    onMount(() => {
      void Promise.allSettled([
        result.location.refresh(),
        result.location.agent.refresh(),
        result.location.integration.refresh(),
        result.location.model.refresh(),
        result.location.provider.refresh(),
        result.location.reference.refresh(),
        result.location.command.refresh(),
        result.location.skill.refresh(),
      ]).then((settled) => {
        for (const failure of settled.filter((item) => item.status === "rejected"))
          console.error("Failed to refresh default location data", failure.reason)
      })
    })

    return result
  },
})

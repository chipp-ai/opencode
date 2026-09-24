export * as SessionTitle from "./title"

import { LLM, LLMError, LLMEvent, Message, SystemPart, type LLMRequest, type Model } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"
import type { AgentV2 } from "../agent"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import type { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import type { SessionStore } from "./store"
import { toLLMMessages } from "./runner/to-llm-message"

const MAX_LENGTH = 100
const DEFAULT_TITLE = /^New session - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** Matches the placeholder `SessionV2.create` assigns, so customized titles are never replaced. */
export const isDefault = (title: string) => DEFAULT_TITLE.test(title)

export const placeholder = (time: number) => `New session - ${new Date(time).toISOString()}`

type Dependencies = {
  readonly events: EventV2.Interface
  readonly store: SessionStore.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
}

type Input = {
  readonly session: SessionSchema.Info
  readonly agent: AgentV2.Info
  readonly model: Model
  readonly context: readonly SessionMessage.Message[]
  readonly http: LLMRequest["http"]
}

/** True when the Session should receive a generated title from its first real user message. */
export const eligible = (session: SessionSchema.Info, context: readonly SessionMessage.Message[]) =>
  session.parentID === undefined &&
  isDefault(session.title) &&
  context.filter((message) => message.type === "user").length === 1

export const make = (dependencies: Dependencies) =>
  Effect.fn("SessionTitle.generate")(function* (input: Input) {
    const firstUser = input.context.findIndex((message) => message.type === "user")
    const text = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          http: input.http,
          system: input.agent.system ? [SystemPart.make(input.agent.system)] : [],
          messages: [
            Message.user("Generate a title for this conversation:\n"),
            ...toLLMMessages(input.context.slice(0, firstUser + 1), input.model),
          ],
          tools: [],
        }),
      )
      .pipe(
        Stream.filter(LLMEvent.is.textDelta),
        Stream.map((event) => event.text),
        Stream.mkString,
      )
    const title = clean(text)
    if (!title) return
    // Generation runs detached from the turn, so a rename that landed meanwhile must win.
    const current = yield* dependencies.store.get(input.session.id)
    if (!current || !isDefault(current.title)) return
    yield* dependencies.events.publish(SessionEvent.TitleChanged, {
      sessionID: input.session.id,
      timestamp: yield* DateTime.now,
      title,
    })
  })

const clean = (text: string) => {
  const line = text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) return
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 3)}...` : line
}

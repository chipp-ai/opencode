import { createMemo, onMount } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useDialog, type DialogContext } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs as strip } from "../../prompt/part"

/** `messages` and `partsFor` are the session's rendered transcript, which for a V2 session is projected from V2 history. */
export function DialogForkFromTimeline(props: {
  sessionID: string
  v2: boolean
  messages: Message[]
  partsFor: (messageID: string) => Part[]
  onMove: (messageID?: string) => void
}) {
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()

  onMount(() => {
    dialog.setSize("large")
  })

  const fork = (messageID?: string) =>
    props.v2
      ? sdk.client.v2.session
          .fork({ sessionID: props.sessionID, messageID }, { throwOnError: true })
          .then((res) => res.data.data.id)
      : sdk.client.session.fork({ sessionID: props.sessionID, messageID }).then((res) => res.data!.id)

  const failed = (error: unknown) =>
    toast.show({ message: error instanceof Error ? error.message : "Failed to fork session", variant: "error" })

  const options = createMemo((): DialogSelectOption<string | undefined>[] => {
    const fullSession = {
      title: "Full session",
      value: undefined,
      onSelect: async (dialog: DialogContext) => {
        await fork()
          .then((sessionID) => route.navigate({ sessionID, type: "session" }))
          .catch(failed)
        dialog.clear()
      },
    } satisfies DialogSelectOption<string | undefined>
    const result = [] as DialogSelectOption<string | undefined>[]
    for (const message of props.messages) {
      if (message.role !== "user") continue
      const part = props.partsFor(message.id).find((x) => x.type === "text" && !x.synthetic && !x.ignored) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: async (dialog) => {
          const prompt = props.partsFor(message.id).reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(strip(part))
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          )
          await fork(message.id)
            .then((sessionID) => route.navigate({ sessionID, type: "session", prompt }))
            .catch(failed)
          dialog.clear()
        },
      })
    }
    return [fullSession, ...result.reverse()]
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Fork session" options={options()} />
}

import { createMemo, createSignal, onMount } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { useData } from "../context/data"
import { useCommandShortcut } from "../keymap"
import { Locale } from "../util/locale"
import { errorMessage } from "../util/error"

/**
 * Lists admitted inputs that have not been promoted yet so the user can edit or remove one before it runs.
 * The server rejects both actions once promotion wins the race, which surfaces here as a toast.
 */
export function DialogQueuedInput(props: { sessionID: string }) {
  const dialog = useDialog()
  const data = useData()
  const toast = useToast()
  const { theme } = useTheme()
  const deleteHint = useCommandShortcut("queue.delete")
  const [toDelete, setToDelete] = createSignal<string>()

  onMount(() => {
    data.session.input.refresh(props.sessionID).catch((error) => {
      toast.show({ title: "Failed to load queued messages", message: errorMessage(error), variant: "error" })
    })
  })

  const options = createMemo(() =>
    (data.session.input.list(props.sessionID) ?? []).map((input) => {
      const deleting = toDelete() === input.id
      const lines = input.prompt.text.split("\n")
      return {
        title: deleting ? `Press ${deleteHint()} again to remove` : Locale.truncate(lines[0]?.trim() || "(empty)", 60),
        bg: deleting ? theme.error : undefined,
        value: input.id,
        description: input.delivery === "queue" ? "queued" : "next turn",
        footer: lines.length > 1 ? `~${lines.length} lines` : undefined,
      }
    }),
  )

  const failed = (action: string) => (error: unknown) =>
    toast.show({
      title: `Could not ${action} queued message`,
      message: `${errorMessage(error)} It may have already started.`,
      variant: "error",
    })

  return (
    <DialogSelect
      title="Queued messages"
      options={options()}
      emptyView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.textMuted}>Nothing is waiting to run.</text>
        </box>
      }
      onMove={() => setToDelete(undefined)}
      onSelect={async (option) => {
        const input = data.session.input.list(props.sessionID)?.find((item) => item.id === option.value)
        if (!input) return
        const text = await DialogPrompt.show(dialog, "Edit queued message", { value: input.prompt.text })
        if (text === null || text === input.prompt.text) {
          dialog.replace(() => <DialogQueuedInput sessionID={props.sessionID} />)
          return
        }
        await data.session.input.revise(props.sessionID, input.id, { ...input.prompt, text }).catch(failed("edit"))
        dialog.replace(() => <DialogQueuedInput sessionID={props.sessionID} />)
      }}
      actions={[
        {
          command: "queue.delete",
          title: "remove",
          onTrigger: (option) => {
            if (toDelete() !== option.value) {
              setToDelete(option.value)
              return
            }
            setToDelete(undefined)
            data.session.input.withdraw(props.sessionID, option.value).catch(failed("remove"))
          },
        },
      ]}
    />
  )
}

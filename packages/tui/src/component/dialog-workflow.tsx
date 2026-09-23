import { TextAttributes } from "@opentui/core"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { createResource, createMemo, createSignal } from "solid-js"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { errorMessage } from "../util/error"

export type DialogWorkflowProps = {
  onSelect: (workflowID: string) => void
}

/** Lists `.opencode/workflows/*.js` scripts discovered for the current location -- see `GET /api/workflow`. */
export function DialogWorkflow(props: DialogWorkflowProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  dialog.setSize("large")

  const [loadError, setLoadError] = createSignal<unknown>()

  const [result] = createResource(() =>
    sdk.client.v2.workflow
      .list({}, { throwOnError: true })
      .then((result) => result.data.data)
      // Catch so the rejected resource never reaches the memo below: reading
      // result() in an errored state re-throws and tears down the dialog.
      .catch((error) => {
        setLoadError(error)
        return undefined
      }),
  )

  const showError = createMemo(() => Boolean(loadError()))

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (showError()) return []
    const list = result()?.workflows ?? []
    const maxWidth = Math.max(0, ...list.map((w) => w.name.length))
    return list.map((workflow) => ({
      title: workflow.name.padEnd(maxWidth),
      description: workflow.description,
      value: workflow.id,
      category: "Workflows",
      onSelect: () => {
        props.onSelect(workflow.id)
        dialog.clear()
      },
    }))
  })

  const lintErrors = createMemo(() => result()?.errors ?? [])

  return (
    <DialogSelect
      title="Workflows"
      placeholder="Search workflows…"
      options={options()}
      renderFilter={!showError()}
      locked={showError()}
      emptyView={
        showError() ? (
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.error} attributes={TextAttributes.BOLD}>
              Could not load workflows
            </text>
            <text fg={theme.textMuted}>{errorMessage(loadError())}</text>
          </box>
        ) : lintErrors().length > 0 ? (
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.textMuted}>No runnable workflows -- {lintErrors().length} file(s) failed to parse:</text>
            {lintErrors().map((error) => (
              <text fg={theme.error}>{error.message}</text>
            ))}
          </box>
        ) : (
          <box paddingLeft={4} paddingRight={4}>
            <text fg={theme.textMuted}>No workflows found in .opencode/workflows/</text>
          </box>
        )
      }
    />
  )
}

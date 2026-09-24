/**
 * A prompt that names a registered command on its first line (`/name args`) dispatches that command.
 * Arguments are the rest of the first line plus any following lines, so multi-line content is preserved.
 */
export function parseSlashCommand(input: string, commands: ReadonlyArray<{ name: string }>) {
  if (!input.startsWith("/")) return
  const firstLineEnd = input.indexOf("\n")
  const firstLine = firstLineEnd === -1 ? input : input.slice(0, firstLineEnd)
  const [head, ...rest] = firstLine.split(" ")
  const name = head.slice(1)
  if (!commands.some((command) => command.name === name)) return
  const remainder = firstLineEnd === -1 ? "" : input.slice(firstLineEnd + 1)
  return { name, arguments: rest.join(" ") + (remainder ? "\n" + remainder : "") }
}

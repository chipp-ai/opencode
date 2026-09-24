// A fake LSP server with a real descendant, standing in for typescript-language-server and
// its tsserver child. The grandchild ignores SIGTERM, so only a SIGKILL escalation removes
// it, and this server exits synchronously on the LSP "exit" notification, which reparents
// the grandchild to init unless the process tree was read before shutdown began.
//
// The grandchild pid is written to grandchild.pid in the working directory (the LSP root)
// before stdin is read. Never to stdout: that is the JSON-RPC transport.
const { spawn } = require("child_process")
const fs = require("fs")
const path = require("path")

const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: "ignore",
})
fs.writeFileSync(path.join(process.cwd(), "grandchild.pid"), String(child.pid))

let buffer = Buffer.alloc(0)

function send(message) {
  const json = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`)
}

function handle(raw) {
  const data = JSON.parse(raw)
  if (data.method === "initialize") return send({ jsonrpc: "2.0", id: data.id, result: { capabilities: {} } })
  if (data.method === "exit") process.exit(0)
  if (data.id !== undefined && data.method !== undefined) send({ jsonrpc: "2.0", id: data.id, result: null })
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const idx = buffer.indexOf("\r\n\r\n")
    if (idx === -1) return
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.slice(0, idx).toString("utf8"))?.[1] ?? 0)
    if (buffer.length < idx + 4 + length) return
    handle(buffer.slice(idx + 4, idx + 4 + length).toString("utf8"))
    buffer = buffer.slice(idx + 4 + length)
  }
})

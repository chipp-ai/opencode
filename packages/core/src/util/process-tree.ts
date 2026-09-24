import { execFile } from "node:child_process"

// Bounded shutdown of a spawned process and every descendant it forked.
//
// Signalling only the direct child is not enough for servers that fork helpers of their
// own (for example `typescript-language-server` forks `tsserver`): a helper that ignores
// SIGTERM, or one reparented to init when its parent exits, survives and keeps its memory.
// The tree is read from `ps` (never `pkill`/`pgrep` by name), every member gets SIGTERM, a
// bounded grace elapses, survivors get SIGKILL, and whatever is still alive is reported.

export interface Row {
  readonly pid: number
  readonly ppid: number
  readonly comm: string
}

export interface KillResult {
  /** The root and every descendant known when the tree was read. */
  readonly targets: number[]
  /** Targets still alive after SIGKILL and its grace. Non-empty means the kill is unconfirmed. */
  readonly survivors: number[]
  /** False when `ps` was unavailable and only the root could be targeted. */
  readonly treeKnown: boolean
}

export interface KillOptions {
  /** A process table read earlier. Pass one read before any graceful shutdown request, so
   *  children reparented to init by a promptly-exiting parent are still targeted. */
  readonly rows?: Row[]
  /** Wait after SIGTERM before escalating. Default 3000 ms. */
  readonly graceMs?: number
  /** Wait after SIGKILL before reporting survivors. Default 1000 ms. */
  readonly killGraceMs?: number
}

/** Parse `ps -A -o pid=,ppid=,comm=` output. `comm` may contain spaces (macOS prints a full path). */
export function parseTable(text: string) {
  return text.split("\n").flatMap((line): Row[] => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line)
    if (!match) return []
    return [{ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] }]
  })
}

/** The live process table, or undefined when it cannot be read. Undefined means unknown, never empty. */
export function table() {
  if (process.platform === "win32") return Promise.resolve(undefined)
  return new Promise<Row[] | undefined>((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,comm="], { maxBuffer: 16 * 1024 * 1024, timeout: 5_000 }, (error, stdout) =>
      resolve(error ? undefined : parseTable(stdout)),
    )
  })
}

/** Every transitive child of `root` in `rows`, breadth first, excluding `root`. */
export function descendants(root: number, rows: Row[]) {
  const children = Map.groupBy(rows, (row) => row.ppid)
  const seen = new Set([root])
  const walk = (frontier: number[]): Row[] => {
    const next = frontier.flatMap((pid) => children.get(pid) ?? []).filter((row) => !seen.has(row.pid))
    if (next.length === 0) return []
    next.forEach((row) => seen.add(row.pid))
    return [...next, ...walk(next.map((row) => row.pid))]
  }
  return walk([root])
}

/** True when `pid` exists. EPERM means it exists but belongs to someone else. */
export function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * SIGTERM the tree under `pid`, wait, SIGKILL survivors, wait, report. Never throws.
 * The tree is read once, before the first signal: a child spawned after that is not targeted.
 */
export async function killTree(pid: number | undefined, options: KillOptions = {}): Promise<KillResult> {
  // 0 and negative pids are kill(2) broadcast forms (own process group, every process,
  // another group), so a caller bug here must never reach process.kill.
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return { targets: [], survivors: [], treeKnown: false }
  const rows = options.rows ?? (await table())
  const targets = [pid, ...(rows ? descendants(pid, rows).map((row) => row.pid) : [])]

  targets.filter(isAlive).forEach((target) => signal(target, "SIGTERM"))
  const afterTerm = await waitGone(targets, options.graceMs ?? 3_000)
  afterTerm.forEach((target) => signal(target, "SIGKILL"))
  const survivors = await waitGone(afterTerm, options.killGraceMs ?? 1_000)
  return { targets, survivors, treeKnown: rows !== undefined }
}

function signal(pid: number, name: "SIGTERM" | "SIGKILL") {
  try {
    process.kill(pid, name)
  } catch {
    // ESRCH (already gone) and EPERM (not ours) both mean there is nothing more to do.
  }
}

async function waitGone(pids: number[], budgetMs: number): Promise<number[]> {
  const remaining = pids.filter(isAlive)
  if (remaining.length === 0 || budgetMs <= 0) return remaining
  const step = Math.min(50, budgetMs)
  await new Promise((resolve) => setTimeout(resolve, step))
  return waitGone(remaining, budgetMs - step)
}

export * as ProcessTree from "./process-tree"

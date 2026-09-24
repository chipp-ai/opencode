export interface RetryOptions {
  attempts?: number
  delay?: number
  factor?: number
  maxDelay?: number
  /** Total wall-clock budget in ms, measured from the first attempt. Once spent, the last error is thrown. */
  budget?: number
  /** Full jitter: each backoff wait is drawn uniformly from [0, computed delay). */
  jitter?: boolean
  retryIf?: (error: unknown) => boolean
  /** Server-requested wait (e.g. a parsed `Retry-After`) that replaces the computed backoff for this attempt. */
  retryAfter?: (error: unknown) => number | undefined
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const TRANSIENT_MESSAGES = [
  "load failed",
  "network connection was lost",
  "network request failed",
  "failed to fetch",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
]

function isTransientError(error: unknown): boolean {
  if (!error) return false
  // oxlint-disable-next-line no-base-to-string -- error is unknown, intentional coercion for message matching
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  return TRANSIENT_MESSAGES.some((m) => message.includes(m))
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3
  const retryIf = options.retryIf ?? isTransientError
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const start = now()

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1 || !retryIf(error)) throw error
      const remaining = options.budget === undefined ? Infinity : options.budget - (now() - start)
      if (remaining <= 0) throw error
      await sleep(Math.min(waitFor(error, attempt, options), remaining))
    }
  }
  throw lastError
}

function waitFor(error: unknown, attempt: number, options: RetryOptions) {
  const maxDelay = options.maxDelay ?? 10_000
  const requested = options.retryAfter?.(error)
  // A server-requested wait is honored verbatim inside a budget (the budget bounds it). Without a budget it is
  // capped at maxDelay so a misconfigured or hostile header cannot stall an unbudgeted caller indefinitely.
  if (requested !== undefined) return options.budget === undefined ? Math.min(requested, maxDelay) : requested
  const backoff = Math.min((options.delay ?? 500) * Math.pow(options.factor ?? 2, attempt), maxDelay)
  return options.jitter ? Math.floor(Math.random() * backoff) : backoff
}

/** 429 is explicit backpressure; every 5xx is a server/transport-side failure worth another attempt. */
export function isRetryableStatus(status: number) {
  return status === 429 || (status >= 500 && status < 600)
}

/**
 * Parses a `Retry-After` header value (delay-seconds or an HTTP-date) into milliseconds. Returns undefined when
 * missing or unparseable so callers fall back to their own backoff. A date in the past clamps to 0 ("retry now").
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()) {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000)
  // Date.parse accepts bare numbers like "-5" as years; an HTTP-date always names a day or month.
  if (!/[a-z]/i.test(trimmed)) return undefined
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

class RetryableStatus extends Error {
  constructor(readonly response: Response) {
    super(`retryable status ${response.status}`)
  }
}

/**
 * `fetch` with bounded retry on transport failures and retryable statuses (429/5xx), honoring `Retry-After`.
 * Non-retryable responses are returned immediately. When retries are exhausted on a retryable status, the last
 * response is returned (not thrown) so callers handle it like any other non-ok response; a transport failure on
 * the final attempt is rethrown. Retrying replays `init` as-is, so only use this for idempotent requests or ones
 * carrying their own idempotency key, and pass a replayable body (string/Blob/ArrayBuffer, not a stream).
 */
export function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  options: Omit<RetryOptions, "retryIf" | "retryAfter"> = {},
) {
  const now = options.now ?? Date.now
  return retry(
    async () => {
      const response = await fetch(input, init)
      if (!isRetryableStatus(response.status)) return response
      throw new RetryableStatus(response)
    },
    {
      ...options,
      retryIf: (error) => !(error instanceof Error && error.name === "AbortError"),
      retryAfter: (error) =>
        error instanceof RetryableStatus
          ? parseRetryAfter(error.response.headers.get("retry-after"), now())
          : undefined,
    },
  ).catch((error) => {
    if (error instanceof RetryableStatus) return error.response
    throw error
  })
}

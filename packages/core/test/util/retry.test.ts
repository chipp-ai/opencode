import { afterEach, describe, expect, test } from "bun:test"
import { fetchWithRetry, isRetryableStatus, parseRetryAfter, retry } from "@opencode-ai/core/util/retry"

const failing = (count: number, error: unknown = new Error("failed to fetch")) => {
  const state = { calls: 0 }
  const fn = async () => {
    state.calls++
    if (state.calls <= count) throw error
    return "ok"
  }
  return { state, fn }
}

// A deterministic clock: sleeping advances time instead of waiting.
const virtualClock = () => {
  const state = { time: 0, sleeps: [] as number[] }
  return {
    state,
    now: () => state.time,
    sleep: async (ms: number) => {
      state.sleeps.push(ms)
      state.time += ms
    },
  }
}

describe("retry", () => {
  test("retries transient failures with exponential backoff", async () => {
    const clock = virtualClock()
    const task = failing(2)
    expect(await retry(task.fn, { sleep: clock.sleep, now: clock.now })).toBe("ok")
    expect(task.state.calls).toBe(3)
    expect(clock.state.sleeps).toEqual([500, 1000])
  })

  test("gives up after the attempt limit and rethrows the last error", async () => {
    const clock = virtualClock()
    const task = failing(Infinity)
    await expect(retry(task.fn, { attempts: 4, sleep: clock.sleep, now: clock.now })).rejects.toThrow("failed to fetch")
    expect(task.state.calls).toBe(4)
    expect(clock.state.sleeps).toHaveLength(3)
  })

  test("does not retry errors rejected by retryIf", async () => {
    const clock = virtualClock()
    const task = failing(Infinity, new Error("bad request"))
    await expect(retry(task.fn, { sleep: clock.sleep, now: clock.now })).rejects.toThrow("bad request")
    expect(task.state.calls).toBe(1)
    expect(clock.state.sleeps).toEqual([])
  })

  test("stops once the wall-clock budget is spent even with attempts left", async () => {
    const clock = virtualClock()
    const task = failing(Infinity)
    await expect(
      retry(task.fn, { attempts: 1_000, delay: 400, factor: 1, budget: 1_000, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow("failed to fetch")
    // 400 + 400 + a final wait clipped to the 200ms left, then one more attempt and give up.
    expect(clock.state.sleeps).toEqual([400, 400, 200])
    expect(task.state.calls).toBe(4)
    expect(clock.state.time).toBe(1_000)
  })

  test("honors a server-requested wait in place of backoff", async () => {
    const clock = virtualClock()
    const task = failing(2)
    await retry(task.fn, { retryAfter: () => 3_000, budget: 60_000, sleep: clock.sleep, now: clock.now })
    expect(clock.state.sleeps).toEqual([3_000, 3_000])
  })

  test("caps a server-requested wait by the remaining budget", async () => {
    const clock = virtualClock()
    const task = failing(Infinity)
    await expect(
      retry(task.fn, { attempts: 10, retryAfter: () => 60_000, budget: 5_000, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow("failed to fetch")
    expect(clock.state.sleeps).toEqual([5_000])
  })

  test("caps a server-requested wait by maxDelay without a budget", async () => {
    const clock = virtualClock()
    const task = failing(1)
    await retry(task.fn, { retryAfter: () => 60_000, sleep: clock.sleep, now: clock.now })
    expect(clock.state.sleeps).toEqual([10_000])
  })

  test("full jitter keeps each wait below the computed backoff", async () => {
    const clock = virtualClock()
    const task = failing(5)
    await retry(task.fn, { attempts: 6, jitter: true, sleep: clock.sleep, now: clock.now })
    clock.state.sleeps.forEach((wait, attempt) => {
      expect(wait).toBeGreaterThanOrEqual(0)
      expect(wait).toBeLessThan(500 * 2 ** attempt)
    })
  })
})

describe("parseRetryAfter", () => {
  test("parses delay-seconds", () => {
    expect(parseRetryAfter("2")).toBe(2_000)
    expect(parseRetryAfter(" 0 ")).toBe(0)
    expect(parseRetryAfter("1.5")).toBe(1_500)
  })

  test("parses an HTTP-date relative to now and clamps past dates to zero", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:30 GMT", now)).toBe(30_000)
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT", now)).toBe(0)
  })

  test("returns undefined for missing or unparseable values", () => {
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter("")).toBeUndefined()
    expect(parseRetryAfter("soon")).toBeUndefined()
    expect(parseRetryAfter("-5")).toBeUndefined()
  })
})

test("isRetryableStatus covers 429 and 5xx only", () => {
  expect([429, 500, 502, 503, 504, 599].every(isRetryableStatus)).toBe(true)
  expect([200, 400, 401, 403, 404, 409, 422, 600].some(isRetryableStatus)).toBe(false)
})

describe("fetchWithRetry", () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = []
  afterEach(() => {
    servers.splice(0).forEach((server) => server.stop(true))
  })

  // Serves the scripted responses in order, then 200 "done" forever. Records each request's arrival time.
  const scripted = (responses: Array<() => Response>) => {
    const arrivals: number[] = []
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        arrivals.push(performance.now())
        return responses[arrivals.length - 1]?.() ?? new Response("done")
      },
    })
    servers.push(server)
    return { url: server.url, arrivals }
  }

  test("waits for Retry-After on 429 and 503 before succeeding", async () => {
    const server = scripted([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "1" } }),
      () => new Response("rolling", { status: 503, headers: { "retry-after": "1" } }),
    ])
    const response = await fetchWithRetry(server.url, undefined, { attempts: 5, budget: 10_000 })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("done")
    expect(server.arrivals).toHaveLength(3)
    expect(server.arrivals[1] - server.arrivals[0]).toBeGreaterThanOrEqual(950)
    expect(server.arrivals[2] - server.arrivals[1]).toBeGreaterThanOrEqual(950)
  })

  test("returns non-retryable responses immediately", async () => {
    const server = scripted([() => new Response("nope", { status: 403 })])
    const response = await fetchWithRetry(server.url, undefined, { attempts: 5, delay: 1 })
    expect(response.status).toBe(403)
    expect(server.arrivals).toHaveLength(1)
  })

  test("returns the last retryable response once attempts are exhausted", async () => {
    const server = scripted(Array.from({ length: 10 }, () => () => new Response("down", { status: 502 })))
    const response = await fetchWithRetry(server.url, undefined, { attempts: 3, delay: 1 })
    expect(response.status).toBe(502)
    expect(await response.text()).toBe("down")
    expect(server.arrivals).toHaveLength(3)
  })

  test("gives up within the budget when Retry-After asks for longer", async () => {
    const server = scripted(
      Array.from({ length: 10 }, () => () => new Response("busy", { status: 429, headers: { "retry-after": "30" } })),
    )
    const started = performance.now()
    const response = await fetchWithRetry(server.url, undefined, { attempts: 10, budget: 300 })
    expect(response.status).toBe(429)
    expect(server.arrivals).toHaveLength(2)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test("retries transport failures and rethrows once attempts are exhausted", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("unused") })
    const url = server.url
    server.stop(true)
    await expect(fetchWithRetry(url, undefined, { attempts: 2, delay: 1 })).rejects.toThrow()
  })
})

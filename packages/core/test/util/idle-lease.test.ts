import { describe, expect, test } from "bun:test"
import { IdleLease } from "@opencode-ai/core/util/idle-lease"

describe("IdleLease.Tracker", () => {
  test("a key is never idle while any holder is live, however old its activity", () => {
    const leases = new IdleLease.Tracker<string>()
    const a = leases.acquire("/repo", 0)
    const b = leases.acquire("/repo", 0)
    expect(leases.holders("/repo")).toBe(2)

    a(10)
    expect(leases.holders("/repo")).toBe(1)
    expect(leases.idle(100, 10_000)).toEqual([])

    b(20)
    expect(leases.holders("/repo")).toBe(0)
    expect(leases.idle(100, 119)).toEqual([])
    expect(leases.idle(100, 120)).toEqual(["/repo"])
  })

  test("release is idempotent", () => {
    const leases = new IdleLease.Tracker<string>()
    const a = leases.acquire("/repo", 0)
    leases.acquire("/repo", 0)
    a(1)
    a(2)
    expect(leases.holders("/repo")).toBe(1)
  })

  test("activity without a holder restarts the idle clock", () => {
    const leases = new IdleLease.Tracker<string>()
    leases.touch("/repo", 0)
    leases.touch("/repo", 90)
    expect(leases.isIdle("/repo", 100, 150)).toBe(false)
    expect(leases.isIdle("/repo", 100, 190)).toBe(true)
  })

  test("keys are tracked independently", () => {
    const leases = new IdleLease.Tracker<string>()
    leases.acquire("/a", 0)
    leases.touch("/b", 0)
    expect(leases.idle(10, 100)).toEqual(["/b"])
  })

  test("forget drops an unheld key but keeps a held one with a fresh clock", () => {
    const leases = new IdleLease.Tracker<string>()
    leases.touch("/free", 0)
    const release = leases.acquire("/held", 0)
    leases.forget("/free", 50)
    leases.forget("/held", 50)
    expect(leases.keys()).toEqual(["/held"])

    release(60)
    expect(leases.isIdle("/held", 100, 159)).toBe(false)
    expect(leases.isIdle("/held", 100, 160)).toBe(true)
  })

  test("a release for a forgotten entry does not affect a newer entry for the same key", () => {
    const leases = new IdleLease.Tracker<string>()
    leases.touch("/repo", 0)
    leases.forget("/repo", 0)
    const stale = leases.acquire("/repo", 0)
    stale(1)
    leases.forget("/repo", 1)
    leases.acquire("/repo", 2)
    stale(3)
    expect(leases.holders("/repo")).toBe(1)
  })
})

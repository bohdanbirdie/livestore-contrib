import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import {
  makeGatewayAlarmRetry,
  makeGatewayOwnerDeadline,
  makeSupervisorGate,
  scheduleGatewayAlarmIfMissing,
} from './loop-gate.ts'

it.effect('the supervision gate admits exactly one claimant among concurrent ticks', () =>
  Effect.gen(function* () {
    const gate = yield* makeSupervisorGate

    // Two overlapping tick paths race tryBegin: exactly one may fork the
    // loop (regression for the TOCTOU where both observed a stale flag).
    const claims = yield* Effect.all([gate.tryBegin, gate.tryBegin], { discard: false })
    expect(claims.filter((claimed) => claimed === true)).toHaveLength(1)

    // After the loop's ensuring releases the slot, the next tick can claim.
    yield* gate.end
    expect(yield* gate.tryBegin).toBe(true)
  }),
)

it.effect('recovers a claimed owner frozen before the first supervisor attempt', () =>
  Effect.gen(function* () {
    const gate = yield* makeSupervisorGate
    const deadline = makeGatewayOwnerDeadline(35_000)
    expect(yield* gate.tryBegin).toBe(true)
    expect(deadline.observe(1_000, true, false).overdue).toBe(false)
    expect(yield* gate.tryBegin).toBe(false)
    expect(deadline.observe(35_999, false, false).overdue).toBe(false)
    expect(deadline.observe(36_000, false, false).overdue).toBe(true)

    yield* gate.end
    deadline.reset()
    expect(yield* gate.tryBegin).toBe(true)
    expect(deadline.observe(36_001, true, false).overdue).toBe(false)
    // Once the replacement reaches ready, a later reconnect gets a fresh
    // establishment window rather than the original owner's expired one.
    expect(deadline.observe(40_000, false, true).claimedAt).toBeUndefined()
    expect(deadline.observe(41_000, false, false).overdue).toBe(false)
  }),
)

it.effect('cron wake schedules a missing alarm without postponing an existing one', () =>
  Effect.gen(function* () {
    let scheduled: number | null = null
    const storage = {
      getAlarm: async () => scheduled,
      setAlarm: async (when: number) => {
        scheduled = when
      },
    }
    expect(yield* scheduleGatewayAlarmIfMissing(storage, () => 1_000)).toBe(true)
    expect(scheduled).toBe(1_000)
    expect(yield* scheduleGatewayAlarmIfMissing(storage, () => 2_000)).toBe(false)
    expect(scheduled).toBe(1_000)
  }),
)

it.effect('a failed cold build keeps the alarm chain alive with bounded retries', () =>
  Effect.gen(function* () {
    let now = 1_000
    let scheduled: number | null = null
    let failures = 0
    const storage = {
      getAlarm: async () => scheduled,
      setAlarm: async (when: number) => {
        scheduled = when
      },
    }
    const retryAlarm = makeGatewayAlarmRetry(storage, () => now)
    const build = Effect.suspend(() =>
      failures++ < 5 ? Effect.die('Discord REST temporarily unavailable') : Effect.succeed('ready'),
    )
    for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000]) {
      const result = yield* Effect.exit(retryAlarm(build))
      expect(result._tag).toBe('Failure')
      expect(scheduled).toBe(now + delay)
      now += delay
      scheduled = null // Cloudflare consumes the alarm before invoking the handler.
    }
    expect(yield* retryAlarm(build)).toBe('ready')
    expect(scheduled).toBeNull()
    expect((yield* Effect.exit(retryAlarm(Effect.die('REST unavailable again'))))._tag).toBe('Failure')
    expect(scheduled).toBe(now + 5_000)
    scheduled = null

    // A cron tick can repair an absent alarm independently of the failed build.
    expect(yield* scheduleGatewayAlarmIfMissing(storage, () => now)).toBe(true)
    expect(scheduled).toBe(now)
    now += 1_000
    expect(yield* scheduleGatewayAlarmIfMissing(storage, () => now)).toBe(false)
    expect(scheduled).toBe(now - 1_000)
  }),
)

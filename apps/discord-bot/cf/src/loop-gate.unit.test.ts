import { expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { makeGatewayOwnerDeadline, makeSupervisorGate } from './loop-gate.ts'

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

import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { makeAutomaticDiagnostics } from './automatic-diagnostics.ts'

it.effect('counts gateway frames independently of the last 20 automatic stages', () =>
  Effect.gen(function* () {
    const diagnostics = makeAutomaticDiagnostics()
    yield* diagnostics.frameReceived
    yield* diagnostics.frameReceived
    for (let n = 0; n < 23; n += 1) {
      yield* diagnostics.record({ stage: 'failed', reason: 'handler_error', correlation: n.toString(16) })
    }
    const snapshot = diagnostics.snapshot()
    expect(snapshot.messageCreateFrames).toBe(2)
    expect(snapshot.recent).toHaveLength(20)
    expect(snapshot.recent[0]?.correlation).toBe('3')
    expect(snapshot.recent[19]?.correlation).toBe('16')
  }),
)

it.effect('redacts an unexpected failure reason before it reaches RuntimeStatus', () =>
  Effect.gen(function* () {
    const diagnostics = makeAutomaticDiagnostics()
    yield* diagnostics.record({ stage: 'failed', reason: 'arbitrary message content' })
    expect(diagnostics.snapshot().recent[0]?.reason).toBe('unknown_failure')
  }),
)

import { expect, it } from '@effect/vitest'
import { DiscordWSCodec, JsonDiscordWSCodecLive } from 'dfx/DiscordGateway/DiscordWS'
import { Context, Effect, Layer } from 'effect'

import {
  gatewayHeartbeatDue,
  makeAutomaticDiagnostics,
  monitorDiscordCodec,
  sendDueGatewayHeartbeat,
} from './automatic-diagnostics.ts'

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

it('counts inbound gateway opcodes, allowlisted dispatches, heartbeat traffic, and closes without payload data', () => {
  const diagnostics = makeAutomaticDiagnostics()
  diagnostics.gatewayFrame({ op: 10, d: { heartbeat_interval: 41_250 } })
  diagnostics.gatewayFrame({ op: 0, t: 'READY', d: { token: 'must-not-appear' } })
  diagnostics.gatewayFrame({ op: 0, t: 'MESSAGE_CREATE', d: { content: 'must-not-appear' } })
  diagnostics.gatewayFrame({ op: 0, t: 'PRIVATE_EVENT', d: { content: 'must-not-appear' } })
  diagnostics.heartbeatSent()
  diagnostics.gatewayFrame({ op: 11 })
  diagnostics.socketClosed(1006)
  const snapshot = diagnostics.snapshot().gatewayFrames
  expect(snapshot.receivedOpcodes).toMatchObject({ dispatch: 3, hello: 1, heartbeatAck: 1 })
  expect(snapshot.dispatches).toMatchObject({ READY: 1, MESSAGE_CREATE: 1, other: 1 })
  expect(snapshot.heartbeatIntervalMs).toBe(41_250)
  expect(snapshot.heartbeatSentCount).toBe(1)
  expect(snapshot.heartbeatAckCount).toBe(1)
  expect(snapshot.socketCloses[0]?.code).toBe(1006)
  expect(JSON.stringify(snapshot)).not.toContain('must-not-appear')
})

it('schedules heartbeats from the HELLO interval and does not send early after a DFX heartbeat', () => {
  const diagnostics = makeAutomaticDiagnostics()
  expect(gatewayHeartbeatDue(diagnostics.snapshot().gatewayFrames, Date.now() + 100_000)).toBe(false)
  diagnostics.gatewayFrame({ op: 10, d: { heartbeat_interval: 40_000 } })
  const hello = diagnostics.snapshot().gatewayFrames.lastHelloAt
  expect(hello).not.toBeNull()
  if (hello === null) return
  expect(gatewayHeartbeatDue(diagnostics.snapshot().gatewayFrames, hello + 39_999)).toBe(false)
  expect(gatewayHeartbeatDue(diagnostics.snapshot().gatewayFrames, hello + 40_000)).toBe(true)
  diagnostics.heartbeatSent()
  const sent = diagnostics.snapshot().gatewayFrames.lastHeartbeatSentAt
  expect(sent).not.toBeNull()
  if (sent === null) return
  expect(gatewayHeartbeatDue(diagnostics.snapshot().gatewayFrames, sent + 39_999)).toBe(false)
  expect(gatewayHeartbeatDue(diagnostics.snapshot().gatewayFrames, sent + 40_000)).toBe(true)
})

it.effect('observes actual DFX JSON codec frames and outgoing heartbeat encoding', () =>
  Effect.gen(function* () {
    const codec = Context.get(yield* Layer.build(JsonDiscordWSCodecLive), DiscordWSCodec)
    const diagnostics = makeAutomaticDiagnostics()
    const monitored = monitorDiscordCodec(codec, diagnostics)
    monitored.decode('{"op":10,"d":{"heartbeat_interval":40000}}')
    monitored.decode('{"op":0,"t":"MESSAGE_CREATE","d":{"content":"private"}}')
    monitored.encode({ op: 1, d: null })
    const snapshot = diagnostics.snapshot().gatewayFrames
    expect(snapshot.receivedOpcodes.hello).toBe(1)
    expect(snapshot.dispatches.MESSAGE_CREATE).toBe(1)
    expect(snapshot.heartbeatSentCount).toBe(1)
    expect(JSON.stringify(snapshot)).not.toContain('private')
  }),
)

it.effect('sends an overdue heartbeat with the persisted sequence only during an alarm invocation', () =>
  Effect.gen(function* () {
    const diagnostics = makeAutomaticDiagnostics()
    diagnostics.gatewayFrame({ op: 10, d: { heartbeat_interval: 40_000 } })
    const hello = diagnostics.snapshot().gatewayFrames.lastHelloAt
    expect(hello).not.toBeNull()
    if (hello === null) return
    const sent: Array<number | null> = []
    let storageReads = 0
    const loadSequence = Effect.sync(() => {
      storageReads += 1
      return 42
    })
    const write = (sequence: number | null) =>
      Effect.sync(() => {
        sent.push(sequence)
      })
    yield* sendDueGatewayHeartbeat(diagnostics.snapshot().gatewayFrames, hello + 39_999, write, loadSequence)
    expect(sent).toEqual([])
    expect(storageReads).toBe(0)
    yield* sendDueGatewayHeartbeat(diagnostics.snapshot().gatewayFrames, hello + 40_000, write, loadSequence)
    expect(sent).toEqual([42])
    expect(storageReads).toBe(1)
    yield* sendDueGatewayHeartbeat(diagnostics.snapshot().gatewayFrames, hello + 40_000, undefined, loadSequence)
    expect(storageReads).toBe(1)
  }),
)

import type { DiscordWSCodecService } from 'dfx/DiscordGateway/DiscordWS'
import { Effect, Schema } from 'effect'

import { AutomaticRejectionReason } from '../../src/threading/model.ts'

const isPolicyReason = Schema.is(AutomaticRejectionReason)
const failureReasons: Record<string, true> = {
  journal_unavailable: true,
  journal_transition_failed: true,
  external_outcome_unknown: true,
  claim_source_mismatch: true,
  discord_definitive_failure: true,
  discord_create_outcome_unknown: true,
  handler_error: true,
}

export type AutomaticStage =
  | 'received'
  | 'eligible'
  | 'rejected'
  | 'claimed'
  | 'rest-create-start'
  | 'created'
  | 'failed'

export interface AutomaticDiagnostic {
  readonly at: number
  readonly stage: AutomaticStage
  /** One-way, per-instance/source correlation; never a raw Discord ID. */
  readonly correlation?: string
  readonly reason?: string
}

export interface GatewayFrameSnapshot {
  readonly receivedOpcodes: {
    readonly dispatch: number
    readonly hello: number
    readonly heartbeatAck: number
    readonly heartbeatRequest: number
    readonly reconnect: number
    readonly invalidSession: number
    readonly other: number
  }
  readonly dispatches: {
    readonly READY: number
    readonly RESUMED: number
    readonly GUILD_CREATE: number
    readonly MESSAGE_CREATE: number
    readonly INTERACTION_CREATE: number
    readonly other: number
  }
  readonly heartbeatIntervalMs: number | null
  readonly lastHelloAt: number | null
  readonly heartbeatSentCount: number
  readonly lastHeartbeatSentAt: number | null
  readonly heartbeatAckCount: number
  readonly lastHeartbeatAckAt: number | null
  readonly lastFrameAt: number | null
  readonly socketCloses: ReadonlyArray<{ readonly at: number; readonly code: number | null }>
}

export interface AutomaticDiagnosticsSnapshot {
  readonly messageCreateFrames: number
  readonly recent: ReadonlyArray<AutomaticDiagnostic>
  readonly gatewayFrames: GatewayFrameSnapshot
}

export interface AutomaticDiagnostics {
  readonly frameReceived: Effect.Effect<void>
  readonly record: (entry: Omit<AutomaticDiagnostic, 'at'>) => Effect.Effect<void>
  /** Called synchronously in DFX's codec before the frame enters its queue. */
  readonly gatewayFrame: (payload: { readonly op: number; readonly t?: string | null; readonly d?: unknown }) => void
  /** Called synchronously immediately before DFX encodes the heartbeat write. */
  readonly heartbeatSent: () => void
  readonly socketClosed: (code?: number) => void
  readonly snapshot: () => AutomaticDiagnosticsSnapshot
}

/** The alarm, not an invocation-less timer, owns a heartbeat deadline. */
export const gatewayHeartbeatDue = (frames: GatewayFrameSnapshot, now: number): boolean => {
  const interval = frames.heartbeatIntervalMs
  const hello = frames.lastHelloAt
  if (interval === null || hello === null) return false
  return now - Math.max(hello, frames.lastHeartbeatSentAt ?? hello) >= interval
}

/** Runs an overdue heartbeat through the alarm's live invocation. */
export const sendDueGatewayHeartbeat = (
  frames: GatewayFrameSnapshot,
  now: number,
  writer: ((sequence: number | null) => Effect.Effect<void>) | undefined,
  loadSequence: Effect.Effect<number | null>,
): Effect.Effect<void> =>
  writer === undefined || gatewayHeartbeatDue(frames, now) === false
    ? Effect.void
    : Effect.flatMap(loadSequence, writer)

/** Observe DFX's actual inbound/outbound codec boundary, before dispatch filtering. */
export const monitorDiscordCodec = (
  codec: DiscordWSCodecService,
  diagnostics: AutomaticDiagnostics,
): DiscordWSCodecService => ({
  ...codec,
  encode: (payload) => {
    const encoded = codec.encode(payload)
    // DFX models the opcode as an enum while the heartbeat literal is its wire value.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-enum-comparison
    if (payload.op === 1) diagnostics.heartbeatSent()
    return encoded
  },
  decode: (input) => {
    const payload = codec.decode(input)
    diagnostics.gatewayFrame(payload)
    return payload
  },
})

/** Instance-owned synchronous records remain visible even if an asynchronous handler stalls. */
export const makeAutomaticDiagnostics = (limit = 20): AutomaticDiagnostics => {
  const recent: AutomaticDiagnostic[] = []
  let messageCreateFrames = 0
  const receivedOpcodes = {
    dispatch: 0,
    hello: 0,
    heartbeatAck: 0,
    heartbeatRequest: 0,
    reconnect: 0,
    invalidSession: 0,
    other: 0,
  }
  const dispatches = { READY: 0, RESUMED: 0, GUILD_CREATE: 0, MESSAGE_CREATE: 0, INTERACTION_CREATE: 0, other: 0 }
  const socketCloses: Array<{ at: number; code: number | null }> = []
  let heartbeatIntervalMs: number | null = null
  let lastHelloAt: number | null = null
  let heartbeatSentCount = 0
  let lastHeartbeatSentAt: number | null = null
  let heartbeatAckCount = 0
  let lastHeartbeatAckAt: number | null = null
  let lastFrameAt: number | null = null
  return {
    gatewayFrame: (payload) => {
      const at = Date.now()
      lastFrameAt = at
      switch (payload.op) {
        case 0:
          receivedOpcodes.dispatch += 1
          if (
            payload.t === 'READY' ||
            payload.t === 'RESUMED' ||
            payload.t === 'GUILD_CREATE' ||
            payload.t === 'MESSAGE_CREATE' ||
            payload.t === 'INTERACTION_CREATE'
          ) {
            dispatches[payload.t] += 1
          } else {
            dispatches.other += 1
          }
          break
        case 10:
          receivedOpcodes.hello += 1
          lastHelloAt = at
          heartbeatIntervalMs =
            typeof payload.d === 'object' &&
            payload.d !== null &&
            'heartbeat_interval' in payload.d &&
            typeof payload.d.heartbeat_interval === 'number' &&
            Number.isFinite(payload.d.heartbeat_interval) === true &&
            payload.d.heartbeat_interval > 0
              ? payload.d.heartbeat_interval
              : null
          break
        case 11:
          receivedOpcodes.heartbeatAck += 1
          heartbeatAckCount += 1
          lastHeartbeatAckAt = at
          break
        case 1:
          receivedOpcodes.heartbeatRequest += 1
          break
        case 7:
          receivedOpcodes.reconnect += 1
          break
        case 9:
          receivedOpcodes.invalidSession += 1
          break
        default:
          receivedOpcodes.other += 1
      }
    },
    heartbeatSent: () => {
      heartbeatSentCount += 1
      lastHeartbeatSentAt = Date.now()
    },
    socketClosed: (code) => {
      if (socketCloses.length === 10) socketCloses.shift()
      socketCloses.push({ at: Date.now(), code: code ?? null })
    },
    frameReceived: Effect.sync(() => {
      messageCreateFrames += 1
    }),
    record: (entry: Omit<AutomaticDiagnostic, 'at'>) =>
      Effect.sync(() => {
        if (recent.length === limit) recent.shift()
        const reason =
          entry.reason === undefined
            ? undefined
            : isPolicyReason(entry.reason) === true || Object.hasOwn(failureReasons, entry.reason) === true
              ? entry.reason
              : 'unknown_failure'
        recent.push({
          at: Date.now(),
          stage: entry.stage,
          ...(entry.correlation === undefined ? {} : { correlation: entry.correlation }),
          ...(reason === undefined ? {} : { reason }),
        })
      }),
    snapshot: (): AutomaticDiagnosticsSnapshot => ({
      messageCreateFrames,
      recent: [...recent],
      gatewayFrames: {
        receivedOpcodes: { ...receivedOpcodes },
        dispatches: { ...dispatches },
        heartbeatIntervalMs,
        lastHelloAt,
        heartbeatSentCount,
        lastHeartbeatSentAt,
        heartbeatAckCount,
        lastHeartbeatAckAt,
        lastFrameAt,
        socketCloses: [...socketCloses],
      },
    }),
  }
}

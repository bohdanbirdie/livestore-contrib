import { describe, expect, it } from 'vitest'

import { makeAutomaticDiagnostics } from './automatic-diagnostics.ts'
import { emptyGatewayTelemetrySnapshot, type GatewayTelemetrySnapshot } from './gateway-telemetry.ts'
import { schemaVersion } from './journal.ts'
import { awaitingAlarmBuildHealth, evaluateReadiness, type ReadinessStatus } from './readiness.ts'

const baseGateway = emptyGatewayTelemetrySnapshot('activation-a')
const readyGateway: GatewayTelemetrySnapshot = {
  lifetime: { ...baseGateway.lifetime, identifies: 1, lastReadyAt: 1_000 },
  current: {
    ...baseGateway.current,
    state: 'ready',
    attempt: 1,
    connectedAt: 1_000,
    lastReadyAt: 1_000,
  },
}
const diagnostic = makeAutomaticDiagnostics()
diagnostic.gatewayFrame({ op: 10, d: { heartbeat_interval: 40_000 } })
diagnostic.heartbeatSent()
diagnostic.gatewayFrame({ op: 11 })
const automaticDiagnostics = diagnostic.snapshot()

const readyStatus: ReadinessStatus = {
  journalSchemaVersion: schemaVersion,
  automaticDiagnostics,
  health: {
    supervisor: 'ready',
    sessionPresent: true,
    gateway: readyGateway,
    lastError: null,
    releaseId: 'sha256:release',
    workerVersionId: 'cf-version-1',
  },
}

it('reports a pending cold build and its last failure without inventing a Discord REST error', () => {
  const pending = awaitingAlarmBuildHealth({
    sinceMs: 1_000,
    lastBuildFailure: undefined,
    releaseId: 'sha256:release',
    workerVersionId: 'cf-version-1',
  })
  expect(pending.lastError).toContain('1970-01-01T00:00:01.000Z')
  expect(pending.lastError).not.toContain('Discord REST')
  expect(evaluateReadiness({ journalSchemaVersion: 0, health: pending }).checks).toEqual({
    journalCurrent: false,
    supervisorReady: false,
    sessionPresent: false,
    gatewayHealthy: false,
    errorFree: false,
  })

  const failed = awaitingAlarmBuildHealth({
    sinceMs: 1_000,
    lastBuildFailure: 'Discord identity check class=HttpClientError reason=TransportError',
    releaseId: 'sha256:release',
    workerVersionId: 'cf-version-1',
  })
  expect(failed.lastError).toContain('1970-01-01T00:00:01.000Z')
  expect(failed.lastError).toContain('class=HttpClientError reason=TransportError')
  expect(evaluateReadiness({ journalSchemaVersion: 0, health: failed }).ready).toBe(false)
})

describe('gateway-aware readiness', () => {
  it('is ready only when the journal, supervisor, session, and telemetry checks all pass', () => {
    expect(evaluateReadiness(readyStatus)).toEqual({
      ready: true,
      releaseId: 'sha256:release',
      workerVersionId: 'cf-version-1',
      checks: {
        journalCurrent: true,
        supervisorReady: true,
        sessionPresent: true,
        gatewayHealthy: true,
        errorFree: true,
      },
    })
  })

  it('expires a missing or stale ACK after two intervals without blocking the first heartbeat', () => {
    const frames = automaticDiagnostics.gatewayFrames
    const ack = frames.lastHeartbeatAckAt
    const hello = frames.lastHelloAt
    expect(ack).not.toBeNull()
    expect(hello).not.toBeNull()
    if (ack === null || hello === null) return
    expect(evaluateReadiness(readyStatus, ack + 79_999).ready).toBe(true)
    expect(evaluateReadiness(readyStatus, ack + 80_001).checks.gatewayHealthy).toBe(false)
    expect(evaluateReadiness({ ...readyStatus, automaticDiagnostics: undefined }, ack).ready).toBe(false)
    const awaitingFirstAck = {
      ...automaticDiagnostics,
      gatewayFrames: { ...frames, lastHeartbeatAckAt: null },
    }
    expect(evaluateReadiness({ ...readyStatus, automaticDiagnostics: awaitingFirstAck }, hello + 79_999).ready).toBe(
      true,
    )
    expect(evaluateReadiness({ ...readyStatus, automaticDiagnostics: awaitingFirstAck }, hello + 80_001).ready).toBe(
      false,
    )
    const newSocket = {
      ...automaticDiagnostics,
      gatewayFrames: { ...frames, lastHelloAt: ack + 1 },
    }
    expect(evaluateReadiness({ ...readyStatus, automaticDiagnostics: newSocket }, ack + 80_002).ready).toBe(false)
  })

  it('withdraws readiness for stale, terminal, and errored gateway health', () => {
    const withCurrent = (
      patch: Partial<NonNullable<ReadinessStatus['health']['gateway']>['current']>,
    ): ReadinessStatus => ({
      ...readyStatus,
      health: {
        ...readyStatus.health,
        gateway: {
          ...readyGateway,
          current: { ...readyGateway.current, ...patch },
        },
      },
    })

    // Lifetime history deliberately remains ready: only this activation's
    // establishment is allowed to satisfy readiness.
    expect(evaluateReadiness(withCurrent({ lastReadyAt: null })).ready).toBe(false)
    expect(
      evaluateReadiness(
        withCurrent({
          state: 'terminal',
          terminalCloseCode: 4_014,
          lastError: 'terminal-close',
        }),
      ).ready,
    ).toBe(false)
    expect(
      evaluateReadiness({
        ...readyStatus,
        health: { ...readyStatus.health, lastError: 'gateway loop failed' },
      }).ready,
    ).toBe(false)
  })

  it('withdraws on disconnect and restores only after the current activation resumes', () => {
    const disconnectedGateway: GatewayTelemetrySnapshot = {
      ...readyGateway,
      current: {
        ...readyGateway.current,
        state: 'disconnected',
        connectedAt: null,
        lastDisconnectedAt: 1_050,
        lastError: 'disconnected',
      },
    }
    const disconnected: ReadinessStatus = {
      ...readyStatus,
      health: {
        ...readyStatus.health,
        gateway: disconnectedGateway,
      },
    }
    expect(evaluateReadiness(readyStatus).ready).toBe(true)
    expect(evaluateReadiness(disconnected).ready).toBe(false)
    expect(
      evaluateReadiness({
        ...disconnected,
        health: {
          ...disconnected.health,
          gateway: {
            ...disconnectedGateway,
            current: {
              ...disconnectedGateway.current,
              state: 'ready',
              connectedAt: 1_100,
              lastResumedAt: 1_100,
              lastError: null,
            },
          },
        },
      }).ready,
    ).toBe(true)
  })

  it('accepts RESUMED as the first current-activation establishment observation', () => {
    expect(
      evaluateReadiness({
        ...readyStatus,
        health: {
          ...readyStatus.health,
          gateway: {
            ...readyGateway,
            current: {
              ...readyGateway.current,
              lastReadyAt: null,
              lastResumedAt: 1_100,
            },
          },
        },
      }).ready,
    ).toBe(true)
  })

  it.each([
    ['journal is stale', { journalSchemaVersion: schemaVersion - 1 }],
    ['supervisor is disconnected', { health: { ...readyStatus.health, supervisor: 'disconnected' as const } }],
    ['session is absent', { health: { ...readyStatus.health, sessionPresent: false } }],
  ])('is not ready when the %s', (_label, patch) => {
    expect(evaluateReadiness({ ...readyStatus, ...patch }).ready).toBe(false)
  })
})

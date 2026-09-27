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

export interface AutomaticDiagnosticsSnapshot {
  readonly messageCreateFrames: number
  readonly recent: ReadonlyArray<AutomaticDiagnostic>
}

export interface AutomaticDiagnostics {
  readonly frameReceived: Effect.Effect<void>
  readonly record: (entry: Omit<AutomaticDiagnostic, 'at'>) => Effect.Effect<void>
  readonly snapshot: () => AutomaticDiagnosticsSnapshot
}

/** Instance-owned synchronous records remain visible even if an asynchronous handler stalls. */
export const makeAutomaticDiagnostics = (limit = 20): AutomaticDiagnostics => {
  const recent: AutomaticDiagnostic[] = []
  let messageCreateFrames = 0
  return {
    frameReceived: Effect.sync(() => {
      messageCreateFrames += 1
    }),
    record: (entry: Omit<AutomaticDiagnostic, 'at'>) =>
      Effect.sync(() => {
        if (recent.length === limit) recent.shift()
        const reason =
          entry.reason === undefined
            ? undefined
            : isPolicyReason(entry.reason) || Object.hasOwn(failureReasons, entry.reason)
              ? entry.reason
              : 'unknown_failure'
        recent.push({
          at: Date.now(),
          stage: entry.stage,
          ...(entry.correlation === undefined ? {} : { correlation: entry.correlation }),
          ...(reason === undefined ? {} : { reason }),
        })
      }),
    snapshot: (): AutomaticDiagnosticsSnapshot => ({ messageCreateFrames, recent: [...recent] }),
  }
}

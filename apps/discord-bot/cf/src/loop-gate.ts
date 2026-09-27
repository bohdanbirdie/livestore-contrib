import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'

export interface SupervisorGate {
  /**
   * Atomically claims the supervision slot: exactly one caller in a field of
   * concurrent ticks observes `true`. The check-and-set happens inside a
   * single `Ref.modify` with NO intervening yield, so two overlapping alarm
   * or cron ticks can never both fork `supervisor.run` (duplicate gateway
   * sessions racing the shared shard-state keys).
   */
  readonly tryBegin: Effect.Effect<boolean>
  /** Releases the slot; called from the loop's `ensuring` finalizer. */
  readonly end: Effect.Effect<void>
}

export const makeSupervisorGate: Effect.Effect<SupervisorGate> = Effect.map(Ref.make(false), (ref) => ({
  tryBegin: Ref.modify(ref, (running) => (running === false ? [true, true] : [false, running])),
  end: Ref.set(ref, false),
}))

/**
 * Bound the lifetime of a claimed owner even if it stalls before its first
 * supervisor attempt (where an attempt-local timeout cannot observe it).
 */
export const makeGatewayOwnerDeadline = (windowMillis: number) => {
  let claimedAt: number | undefined
  return {
    observe: (now: number, claimed: boolean, readyOrStopped: boolean) => {
      if (claimed) claimedAt = now
      else if (readyOrStopped) claimedAt = undefined
      else claimedAt ??= now
      return {
        claimedAt,
        overdue: !claimed && claimedAt !== undefined && now - claimedAt >= windowMillis,
      }
    },
    reset: () => {
      claimedAt = undefined
    },
  }
}

/** Cron and pending admin handlers may wake the alarm, never the owner. */
export const scheduleGatewayAlarmIfMissing = (
  storage: {
    readonly getAlarm: () => Promise<number | null | undefined>
    readonly setAlarm: (when: number) => Promise<void>
  },
  now: () => number = Date.now,
): Effect.Effect<{ readonly repaired: boolean; readonly scheduledAt: number }> =>
  Effect.promise(async () => {
    const scheduled = await storage.getAlarm()
    if (scheduled !== null && scheduled !== undefined) return { repaired: false, scheduledAt: scheduled }
    const scheduledAt = now()
    await storage.setAlarm(scheduledAt)
    return { repaired: true, scheduledAt }
  })

/** Failed alarm invocations retry without turning persistent build errors into a hot loop. */
export const makeGatewayAlarmRetry = (
  storage: { readonly setAlarm: (when: number) => Promise<void> },
  now: () => number = Date.now,
) => {
  let failures = 0
  return <A, E, R>(alarm: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    alarm.pipe(
      Effect.onExit((exit) => {
        if (exit._tag === 'Success') {
          failures = 0
          return Effect.void
        }
        const delay = Math.min(60_000, 5_000 * 2 ** Math.min(failures++, 4))
        return Effect.promise(() => storage.setAlarm(now() + delay)).pipe(
          Effect.tap(() => Effect.sync(() => console.warn(`[bot-state] alarm failed; retryScheduledInMs=${delay}`))),
        )
      }),
    )
}

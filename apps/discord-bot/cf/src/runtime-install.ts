import * as Effect from 'effect/Effect'
import type * as Fiber from 'effect/Fiber'
import * as Scheduler from 'effect/Scheduler'
import * as Semaphore from 'effect/Semaphore'

/**
 * Keep instance-owned gateway fibers off Effect's default macrotask dispatcher.
 * On Workers, MixedScheduler's async mode uses setTimeout(0); a pending flush
 * associated with an ended invocation can strand every later socket callback
 * and handshake deadline even while new alarm invocations run. Sync mode still
 * enforces the normal operation yield budget but dispatches via queueMicrotask.
 */
export const makeInstanceFiberRunner = Effect.map(Effect.context(), (instanceContext) => {
  const scheduler = new Scheduler.MixedScheduler('sync')
  return {
    fork: (program: Effect.Effect<void>): Effect.Effect<Fiber.Fiber<void, unknown>> =>
      Effect.sync(() => Effect.runForkWith(instanceContext)(program, { scheduler })),
  }
})

export interface SerializedRuntime<TRuntime> {
  /** Installs the lazy runtime at most once and returns the installed value. */
  readonly get: Effect.Effect<TRuntime>
  /** Synchronous observation for control-plane summaries only. */
  readonly peek: () => TRuntime | undefined
  /** Runs a short lifecycle-critical action while replacement is excluded. */
  readonly withCurrent: <TValue, TError, TRequirements>(
    use: (runtime: TRuntime) => Effect.Effect<TValue, TError, TRequirements>,
  ) => Effect.Effect<TValue, TError, TRequirements>
  /**
   * Stop the current owner and discard its runtime; the next `get` builds
   * from durable config in its own invocation. `expected` protects alarm
   * watchdogs from discarding a newer reload's runtime.
   */
  readonly reset: (
    beforeReset: (current: TRuntime | undefined) => Effect.Effect<void>,
    expected?: TRuntime,
  ) => Effect.Effect<boolean>
}

/**
 * One mutex owns the complete async install/swap lifecycle. Callers cannot
 * observe or start a candidate until its activation has completed, and a cold
 * tick racing status cannot build two independent supervisors.
 */
export const makeSerializedRuntime = <TRuntime>(
  build: Effect.Effect<TRuntime>,
  activate: (runtime: TRuntime) => Effect.Effect<void>,
): Effect.Effect<SerializedRuntime<TRuntime>> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    let current: TRuntime | undefined

    const getUnlocked = Effect.suspend(() => {
      if (current !== undefined) return Effect.succeed(current)
      return Effect.flatMap(build, (candidate) =>
        Effect.as(
          activate(candidate).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                current = candidate
              }),
            ),
          ),
          candidate,
        ),
      )
    })

    const get = Semaphore.withPermits(lock, 1)(getUnlocked)

    const withCurrent: SerializedRuntime<TRuntime>['withCurrent'] = (use) =>
      Semaphore.withPermits(lock, 1)(Effect.flatMap(getUnlocked, use))

    const reset: SerializedRuntime<TRuntime>['reset'] = (beforeReset, expected) =>
      Semaphore.withPermits(
        lock,
        1,
      )(
        Effect.gen(function* () {
          if (expected !== undefined && current !== expected) return false
          yield* beforeReset(current)
          current = undefined
          return true
        }),
      )

    return {
      get,
      peek: () => current,
      withCurrent,
      reset,
    }
  })

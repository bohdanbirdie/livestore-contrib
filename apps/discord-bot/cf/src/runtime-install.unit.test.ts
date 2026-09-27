import { it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Scheduler from 'effect/Scheduler'
import { expect } from 'vitest'

import { makeRuntimeConfigAdminOperations } from './admin-ops.ts'
import { makeFakeDoStorage } from './fake-do-storage.ts'
import { makeGatewayOwnerDeadline, makeSupervisorGate } from './loop-gate.ts'
import { makeRuntimeConfigStore } from './runtime-config.ts'
import { makeInstanceFiberRunner, makeSerializedRuntime } from './runtime-install.ts'

it.effect('a concurrent cold tick and status install and activate one supervisor runtime', () =>
  Effect.gen(function* () {
    const buildStarted = yield* Deferred.make<void>()
    const releaseBuild = yield* Deferred.make<void>()
    let buildCount = 0
    let activationCount = 0
    let supervisorStartCount = 0

    const runtime = yield* makeSerializedRuntime(
      Effect.gen(function* () {
        buildCount++
        yield* Deferred.succeed(buildStarted, undefined)
        yield* Deferred.await(releaseBuild)
        return { id: `runtime-${buildCount}` }
      }),
      (_candidate) =>
        Effect.sync(() => {
          activationCount++
        }),
    )

    const [statusRuntime, tickRuntime] = yield* Effect.all(
      [
        runtime.get,
        runtime.withCurrent((current) =>
          Effect.sync(() => {
            supervisorStartCount++
            return current
          }),
        ),
        Deferred.await(buildStarted).pipe(Effect.andThen(Deferred.succeed(releaseBuild, undefined))),
      ],
      { concurrency: 'unbounded' },
    )

    expect(statusRuntime).toBe(tickRuntime)
    expect(buildCount).toBe(1)
    expect(activationCount).toBe(1)
    expect(supervisorStartCount).toBe(1)
  }),
)

it.effect('a reload during the alarm await makes that alarm rebuild the replacement', () =>
  Effect.gen(function* () {
    let version = 'old'
    const runtime = yield* makeSerializedRuntime(
      Effect.sync(() => ({ id: version })),
      () => Effect.void,
    )
    const initial = yield* runtime.get
    const tickWaitingOnAlarm = yield* Deferred.make<void>()
    const alarmReadCompleted = yield* Deferred.make<void>()

    const [started] = yield* Effect.all(
      [
        Effect.gen(function* () {
          yield* runtime.get
          yield* Deferred.succeed(tickWaitingOnAlarm, undefined)
          yield* Deferred.await(alarmReadCompleted)
          return yield* runtime.withCurrent(Effect.succeed)
        }),
        Deferred.await(tickWaitingOnAlarm).pipe(
          Effect.andThen(
            runtime.reset((current) =>
              Effect.sync(() => {
                expect(current).toBe(initial)
                version = 'new'
              }),
            ),
          ),
          Effect.andThen(Deferred.succeed(alarmReadCompleted, undefined)),
        ),
      ],
      { concurrency: 'unbounded' },
    )

    expect(started).toEqual({ id: 'new' })
  }),
)

it.effect('holds reset behind an in-flight runtime operation and rebuilds on the next get', () =>
  Effect.gen(function* () {
    let builds = 0
    const runtime = yield* makeSerializedRuntime(
      Effect.sync(() => ({ id: `runtime-${++builds}` })),
      () => Effect.void,
    )
    const initial = yield* runtime.get
    const operationEntered = yield* Deferred.make<void>()
    const releaseOperation = yield* Deferred.make<void>()
    const resetAttempted = yield* Deferred.make<void>()
    let stopped = false

    const [appliedRuntime] = yield* Effect.all(
      [
        runtime.withCurrent((current) =>
          Deferred.succeed(operationEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseOperation)),
            Effect.as(current),
          ),
        ),
        Deferred.succeed(resetAttempted, undefined).pipe(
          Effect.andThen(
            runtime.reset((_current) =>
              Effect.sync(() => {
                stopped = true
              }),
            ),
          ),
        ),
        Effect.gen(function* () {
          yield* Deferred.await(operationEntered)
          yield* Deferred.await(resetAttempted)
          yield* Effect.yieldNow
          expect(runtime.peek()).toBe(initial)
          expect(stopped).toBe(false)
          yield* Deferred.succeed(releaseOperation, undefined)
        }),
      ],
      { concurrency: 'unbounded' },
    )

    expect(appliedRuntime).toBe(initial)
    expect(stopped).toBe(true)
    expect(runtime.peek()).toBeUndefined()
    expect((yield* runtime.get).id).toBe('runtime-2')
  }),
)

it.effect('reload validates in the RPC but the next alarm builds and starts the runtime', () =>
  Effect.gen(function* () {
    const backing = makeFakeDoStorage()
    let alarm: number | undefined
    const storage = {
      ...backing,
      getAlarm: async () => alarm,
      setAlarm: async (when: number | Date) => {
        alarm = Number(when)
      },
      deleteAlarm: async () => {
        alarm = undefined
      },
    }
    const store = makeRuntimeConfigStore(storage, 'test-release')
    const gate = yield* makeSupervisorGate
    let invocation: 'boot' | 'rpc' | 'alarm' = 'boot'
    const runtime = yield* makeSerializedRuntime(
      Effect.map(Effect.orDie(store.read), (document) => ({ document, builtIn: invocation })),
      () => Effect.void,
    )
    const old = yield* runtime.get
    yield* gate.tryBegin
    let validatedIn: string | undefined
    const operations = makeRuntimeConfigAdminOperations({
      store,
      getRunning: () => runtime.peek()?.document,
      buildCandidate: (document) =>
        Effect.sync(() => {
          validatedIn = invocation
          return document
        }),
      activateCandidate: () =>
        runtime.reset(() => gate.end).pipe(Effect.andThen(Effect.promise(() => storage.setAlarm(Date.now())))),
    })

    invocation = 'rpc'
    const outcome = yield* operations.configPut({
      expectedRevision: 0,
      reload: true,
      config: structuredClone(old.document.config),
    })
    expect(outcome).toMatchObject({ ok: true, body: { _tag: 'Success', applied: true } })
    expect(validatedIn).toBe('rpc')
    expect(runtime.peek()).toBeUndefined()
    expect(alarm).toBeLessThanOrEqual(Date.now())
    expect((yield* operations.configGet).body).toMatchObject({
      stored: { revision: 1 },
      running: null,
      diverged: true,
    })

    invocation = 'alarm'
    const next = yield* runtime.withCurrent(Effect.succeed)
    expect(yield* gate.tryBegin).toBe(true)
    expect(next.builtIn).toBe('alarm')
    expect(next.document.revision).toBe(1)
    expect(next).not.toBe(old)
    backing.close()
  }),
)

it.effect('alarm watchdog replaces an owner stuck before its first attempt', () =>
  Effect.gen(function* () {
    let builds = 0
    const runtime = yield* makeSerializedRuntime(
      Effect.sync(() => ({ id: ++builds })),
      () => Effect.void,
    )
    const gate = yield* makeSupervisorGate
    const deadline = makeGatewayOwnerDeadline(35_000)
    const current = yield* runtime.get
    expect(yield* gate.tryBegin).toBe(true)
    const owner = yield* Effect.forkScoped(Effect.never)
    deadline.observe(10_000, true, false)

    expect(yield* gate.tryBegin).toBe(false)
    expect(deadline.observe(44_999, false, false).overdue).toBe(false)
    expect(deadline.observe(45_000, false, false).overdue).toBe(true)
    expect(yield* runtime.reset(() => Fiber.interrupt(owner).pipe(Effect.andThen(gate.end)), current)).toBe(true)
    deadline.reset()
    expect(runtime.peek()).toBeUndefined()
    expect(yield* gate.tryBegin).toBe(true)
    const next = yield* runtime.get
    expect(next.id).toBe(2)
    expect(next).not.toBe(current)
    expect(yield* runtime.reset(() => Effect.void, current)).toBe(false)
    expect(runtime.peek()).toBe(next)
  }),
)

it.effect('an instance gateway resumes after its original macrotask context ends', () =>
  Effect.gen(function* () {
    // Model a platform timer created in an invocation that has ended: the
    // default async scheduler can enqueue a flush, but it will never run.
    const strandedTasks: Array<() => void> = []
    const strandedScheduler = new Scheduler.MixedScheduler('async', (task) => {
      strandedTasks.push(task)
      return () => {}
    })
    const [constructorContext, runner] = yield* Effect.all([Effect.context(), makeInstanceFiberRunner]).pipe(
      Effect.provideService(Scheduler.Scheduler, strandedScheduler),
    )
    let oldEstablished = false
    Effect.runForkWith(constructorContext)(
      Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            oldEstablished = true
          }),
        ),
      ),
    )
    yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)))
    expect(oldEstablished).toBe(false)
    expect(strandedTasks).toHaveLength(1)
    strandedTasks.shift()?.()
    expect(oldEstablished).toBe(true)

    let established = false
    yield* runner.fork(
      Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            established = true
          }),
        ),
      ),
    )
    // The gateway's continuation needs a runnable dispatcher even when no
    // macrotask from the constructor's invocation can ever be delivered.
    yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)))
    expect(established).toBe(true)
    expect(strandedTasks).toHaveLength(0)
  }),
)

import { expect, it } from '@effect/vitest'
import { layer as discordConfigLayer } from 'dfx/DiscordConfig'
import { DiscordWS, DiscordWSCodec, JsonDiscordWSCodecLive } from 'dfx/DiscordGateway/DiscordWS'
import { Messaging, MesssagingLive } from 'dfx/DiscordGateway/Messaging'
import { Shard } from 'dfx/DiscordGateway/Shard'
import { ShardStateStore } from 'dfx/DiscordGateway/Shard/StateStore'
import { MemoryRateLimitStoreLive, RateLimitStore } from 'dfx/RateLimit'
import { Cause, Context, Effect, Exit, Fiber, Layer, PubSub, Queue, Redacted, Scope } from 'effect'
import { layerWebSocketConstructorGlobal } from 'effect/unstable/socket/Socket'

import type { DiscordEventHandlersService } from '../../src/discord/events.ts'
import { routeInteraction, routeMessage } from '../../src/discord/routes.ts'
import { makeAutomaticDiagnostics, monitorDiscordCodec } from './automatic-diagnostics.ts'
import { makeSharedShardLayer } from './gateway-shard.ts'

it.effect('routes later MESSAGE_CREATE and INTERACTION_CREATE frames through the shard shared dispatch hub', () =>
  Effect.gen(function* () {
    const attemptScope = yield* Scope.make()
    const rawFrames = yield* Queue.unbounded<string>()
    const seen: string[] = []
    const routed: string[] = []
    const diagnostics = makeAutomaticDiagnostics()
    const codec = Context.get(yield* Layer.build(JsonDiscordWSCodecLive), DiscordWSCodec)
    const observedCodec = monitorDiscordCodec(codec, diagnostics)
    const messaging = Context.get(yield* Scope.provide(Layer.build(MesssagingLive), attemptScope), Messaging)
    const rateLimitStore = Context.get(yield* Layer.build(MemoryRateLimitStoreLive), RateLimitStore)
    const socket = DiscordWS.of({
      connect: () =>
        Effect.succeed({
          take: Effect.map(Queue.take(rawFrames), observedCodec.decode),
          failure: Effect.never,
          setUrl: () => Effect.void,
          write: () => Effect.void,
        }),
    })
    const shard = Context.get(
      yield* Scope.provide(
        Layer.build(
          makeSharedShardLayer({
            messaging: Layer.succeed(Messaging, messaging),
            expectedHub: messaging.hub,
            discordWS: Layer.succeed(DiscordWS, socket),
            rateLimitStore: Layer.succeed(RateLimitStore, rateLimitStore),
            config: discordConfigLayer({ token: Redacted.make('test-token'), gateway: { intents: 1 } }),
            shardStateStore: ShardStateStore.MemoryLive,
          }),
        ),
        attemptScope,
      ),
      Shard,
    )
    yield* Scope.provide(shard.connect([0, 1]), attemptScope)
    const handlers: DiscordEventHandlersService = {
      onAutomaticMessage: (input) =>
        Effect.sync(() => {
          seen.push(`automatic:${input.messageId}`)
        }),
      onCreateThreadInteraction: (input) =>
        Effect.sync(() => {
          seen.push(`manual:${input.sourceMessage.messageId}`)
        }),
      onDocsInteraction: (input) =>
        Effect.sync(() => {
          seen.push(`docs:${input.query}`)
        }),
    }
    // Subscribe before frame injection: a PubSub intentionally does not replay
    // messages published before a subscriber starts.
    const subscription = yield* Scope.provide(PubSub.subscribe(messaging.hub), attemptScope)
    const pump = yield* Scope.provide(
      Effect.forever(
        PubSub.take(subscription).pipe(
          Effect.flatMap((payload) =>
            Effect.sync(() => {
              routed.push(payload.t ?? 'other')
            }).pipe(
              Effect.andThen(
                payload.t === 'MESSAGE_CREATE'
                  ? routeMessage(payload.d, handlers)
                  : payload.t === 'INTERACTION_CREATE'
                    ? routeInteraction(payload.d, handlers)
                    : Effect.void,
              ),
            ),
          ),
        ),
      ).pipe(Effect.forkScoped),
      attemptScope,
    )
    // The socket and subscriber were constructed under an earlier scope. A
    // future microtask delivers the Gateway frames after construction returns.
    yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)))
    yield* Queue.offer(rawFrames, JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
    yield* Queue.offer(
      rawFrames,
      JSON.stringify({
        op: 0,
        t: 'READY',
        s: 1,
        d: { session_id: 'test-session', resume_gateway_url: 'wss://gateway.discord.test' },
      }),
    )
    const sourceId = '100000000000000003'
    const source = {
      id: sourceId,
      channel_id: '100000000000000002',
      author: { id: '100000000000000004' },
      content: 'How does sync work?',
      type: 0,
      attachments: [],
    }
    yield* Queue.offer(
      rawFrames,
      JSON.stringify({
        op: 0,
        t: 'MESSAGE_CREATE',
        s: 2,
        d: { ...source, guild_id: '100000000000000001' },
      }),
    )
    const baseInteraction = {
      type: 2,
      id: '100000000000000005',
      application_id: '100000000000000006',
      token: 'interaction-token',
      guild_id: '100000000000000001',
      channel_id: '100000000000000002',
      app_permissions: '0',
      member: { user: { id: '100000000000000007' }, roles: [], permissions: '0' },
    }
    yield* Queue.offer(
      rawFrames,
      JSON.stringify({
        op: 0,
        t: 'INTERACTION_CREATE',
        s: 3,
        d: {
          ...baseInteraction,
          data: {
            type: 3,
            name: 'Create Thread',
            target_id: sourceId,
            resolved: { messages: { [sourceId]: source } },
          },
        },
      }),
    )
    yield* Queue.offer(
      rawFrames,
      JSON.stringify({
        op: 0,
        t: 'INTERACTION_CREATE',
        s: 4,
        d: {
          ...baseInteraction,
          data: {
            type: 1,
            name: 'docs',
            options: [{ name: 'query', type: 3, value: 'sync' }],
          },
        },
      }),
    )
    for (let n = 0; n < 100 && seen.length < 3; n += 1) {
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
    }
    expect(diagnostics.snapshot().gatewayFrames.dispatches).toMatchObject({
      MESSAGE_CREATE: 1,
      INTERACTION_CREATE: 2,
    })
    expect(pump.pollUnsafe()).toBeUndefined()
    expect(routed).toEqual(['READY', 'MESSAGE_CREATE', 'INTERACTION_CREATE', 'INTERACTION_CREATE'])
    expect(seen).toEqual([`automatic:${sourceId}`, `manual:${sourceId}`, 'docs:sync'])
    yield* Fiber.interrupt(pump)
    yield* Scope.close(attemptScope, Exit.void)
  }).pipe(Effect.provide(layerWebSocketConstructorGlobal)),
)

it.effect('rejects a shard wired to a different Messaging hub than the dispatch pump', () =>
  Effect.gen(function* () {
    const shardMessaging = Context.get(yield* Layer.build(MesssagingLive), Messaging)
    const pumpMessaging = Context.get(yield* Layer.build(MesssagingLive), Messaging)
    const rateLimitStore = Context.get(yield* Layer.build(MemoryRateLimitStoreLive), RateLimitStore)
    const mismatch = makeSharedShardLayer({
      messaging: Layer.succeed(Messaging, shardMessaging),
      expectedHub: pumpMessaging.hub,
      discordWS: Layer.succeed(DiscordWS, DiscordWS.of({ connect: () => Effect.die('socket must not start') })),
      rateLimitStore: Layer.succeed(RateLimitStore, rateLimitStore),
      config: discordConfigLayer({ token: Redacted.make('test-token'), gateway: { intents: 1 } }),
      shardStateStore: ShardStateStore.MemoryLive,
    })
    const result = yield* Effect.exit(Effect.scoped(Layer.build(mismatch)))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(Cause.pretty(result.cause)).toContain('different Messaging hubs')
  }),
)

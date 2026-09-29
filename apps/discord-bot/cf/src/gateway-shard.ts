import type { DiscordConfig } from 'dfx/DiscordConfig'
import type { DiscordWS } from 'dfx/DiscordGateway/DiscordWS'
// oxlint-disable-next-line consistent-type-imports -- Messaging is a runtime Effect service yielded below.
import { Messaging } from 'dfx/DiscordGateway/Messaging'
import { Shard, make as makeShard } from 'dfx/DiscordGateway/Shard'
import type { ShardStateStore } from 'dfx/DiscordGateway/Shard/StateStore'
import { RateLimiterLive, type RateLimitStore } from 'dfx/RateLimit'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

/**
 * ShardLive supplies a private MessagingLive, distinct from the hub consumed
 * by the dispatch pump. Build Shard.make with the exact shared hub instead.
 */
export const makeSharedShardLayer = (input: {
  readonly messaging: Layer.Layer<Messaging>
  /** Identity of the exact hub consumed by the dispatch pump. */
  readonly expectedHub: object
  readonly discordWS: Layer.Layer<DiscordWS>
  readonly rateLimitStore: Layer.Layer<RateLimitStore>
  readonly config: Layer.Layer<DiscordConfig>
  readonly shardStateStore: Layer.Layer<ShardStateStore>
}): Layer.Layer<Shard> =>
  Layer.effect(
    Shard,
    Effect.gen(function* () {
      if ((yield* Messaging).hub !== input.expectedHub) {
        return yield* Effect.die(new Error('Gateway Shard and dispatch pump use different Messaging hubs'))
      }
      return yield* makeShard
    }),
  ).pipe(
    Layer.provide(input.messaging),
    Layer.provide(input.discordWS),
    Layer.provide(RateLimiterLive),
    Layer.provide(input.rateLimitStore),
    Layer.provide(input.config),
    Layer.provide(input.shardStateStore),
  )

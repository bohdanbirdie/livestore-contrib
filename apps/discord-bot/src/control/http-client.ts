import { Effect, Schema, type Scope } from 'effect'
import { RpcClient } from 'effect/unstable/rpc'
import type { RpcGroup } from 'effect/unstable/rpc'
import type { FromServer } from 'effect/unstable/rpc/RpcMessage'

import { adminRoutes } from '../runtime/admin-routes.ts'
import { BotControl, type BotControlClient, type BotControlOperation } from './contract.ts'
import {
  ControlAuthorizationRejected,
  ControlDependencyUnavailable,
  ControlError,
  ControlResult,
  DeploymentEnvironment,
  DiscordSnowflake,
  InvalidControlInput,
  MutationGuard,
  type ControlError as ControlErrorType,
  type ControlResult as ControlResultType,
} from './schema.ts'

const decodeOptional = (schema: typeof ControlResult | typeof ControlError, value: unknown): unknown => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    return undefined
  }
}

/**
 * The HTTPS admin plane implements a subset of the socket contract. Unsupported
 * operations fail locally instead of posting to a route that does not exist.
 */
const adminRoute = (
  operation: BotControlOperation,
):
  | { readonly method: 'POST'; readonly path: string }
  | { readonly method: 'GET'; readonly path: string }
  | undefined => {
  switch (operation) {
    case 'ThreadCreate':
      return adminRoutes.threadCreate
    case 'ThreadReconcile':
      return adminRoutes.threadReconcile
    case 'RuntimeStatus':
      return adminRoutes.runtimeStatus
    case 'ApplicationCommandsSync':
      return adminRoutes.commandsSync
    case 'EffectiveConfig':
      return adminRoutes.configGet
    default:
      return undefined
  }
}

const RunningConfig = Schema.Struct({
  running: Schema.NullOr(
    Schema.Struct({
      summary: Schema.Struct({
        environment: DeploymentEnvironment,
        applicationId: DiscordSnowflake,
        guildId: DiscordSnowflake,
      }),
    }),
  ),
})

/** Authenticated HTTPS transport exposing the CLI's BotControlClient interface. */
export const makeHttpsBotControlClient = (
  baseUrl: string,
  token: string,
): Effect.Effect<BotControlClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    let writeResponse: ((message: FromServer<RpcGroup.Rpcs<typeof BotControl>>) => Effect.Effect<void>) | undefined
    const built = yield* RpcClient.makeNoSerialization(BotControl, {
      supportsAck: false,
      onFromClient: ({ message }) => {
        if (message._tag !== 'Request') return Effect.void
        return Effect.exit(requestOperation(baseUrl, token, message.tag, message.payload)).pipe(
          Effect.flatMap((exit) =>
            writeResponse === undefined
              ? Effect.die('Bot control client response channel was not initialized')
              : writeResponse({ _tag: 'Exit', clientId: 0, requestId: message.id, exit }),
          ),
        )
      },
    })
    writeResponse = built.write
    return built.client
  })

const requestOperation = (
  baseUrl: string,
  token: string,
  operation: BotControlOperation,
  payload: unknown,
): Effect.Effect<ControlResultType, ControlErrorType> =>
  Effect.gen(function* () {
    const route = adminRoute(operation)
    if (route === undefined) {
      return yield* new ControlDependencyUnavailable({
        dependency: 'admin-endpoint',
        message: `${operation} is not supported by the HTTPS admin plane`,
      })
    }
    let requestPayload = payload
    if (operation === 'ApplicationCommandsSync') {
      // The Worker requires a fingerprint of the *running* config. Read it
      // before syncing so a stale/stopped runtime cannot authorize a write.
      const config = yield* fetchAdmin(baseUrl, token, adminRoutes.configGet)
      const configBody: unknown = yield* Effect.promise(() => config.json().catch(() => undefined))
      if (config.ok === false) return yield* responseError(config, configBody)
      const running = Schema.decodeUnknownOption(RunningConfig)(configBody)
      if (running._tag === 'None') return yield* new InvalidControlInput({ message: 'Malformed admin config response' })
      if (running.value.running === null) {
        return yield* new ControlDependencyUnavailable({
          dependency: 'runtime-config',
          message: 'No running config is available for command sync',
        })
      }
      const guard = yield* Schema.decodeUnknownEffect(Schema.Struct(MutationGuard))(payload).pipe(
        Effect.mapError(() => new InvalidControlInput({ message: 'Invalid command sync payload' })),
      )
      requestPayload = {
        ...guard,
        expectedApplicationId: running.value.running.summary.applicationId,
        expectedGuildId: running.value.running.summary.guildId,
      }
    }
    const encodedPayload =
      route.method === 'POST'
        ? yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(requestPayload ?? {}).pipe(
            Effect.mapError(
              () =>
                new ControlDependencyUnavailable({
                  dependency: 'admin-endpoint',
                  message: 'Could not reach the admin endpoint',
                }),
            ),
          )
        : undefined
    const response = yield* fetchAdmin(baseUrl, token, route, encodedPayload)
    const body: unknown = yield* Effect.promise(() => response.json().catch(() => undefined))
    if (response.ok === true) {
      const result = decodeOptional(ControlResult, body)
      if (result !== undefined) return result as ControlResultType
      return yield* new InvalidControlInput({ message: 'Malformed admin response' })
    }
    return yield* responseError(response, body)
  })

const fetchAdmin = (
  baseUrl: string,
  token: string,
  route: { readonly method: 'GET' | 'POST'; readonly path: string },
  body?: string,
) =>
  Effect.tryPromise({
    try: () =>
      globalThis.fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      }),
    catch: () =>
      new ControlDependencyUnavailable({
        dependency: 'admin-endpoint',
        message: 'Could not reach the admin endpoint',
      }),
  })

const responseError = (response: Response, body: unknown): Effect.Effect<never, ControlErrorType> =>
  Effect.gen(function* () {
    const decoded = decodeOptional(ControlError, body)
    if (decoded !== undefined) return yield* decoded as ControlErrorType
    // Proxies and outages may return bodies outside the admin protocol.
    if (response.status === 401) {
      return yield* new ControlAuthorizationRejected({ message: 'Admin endpoint rejected the bearer token' })
    }
    if (response.status === 404) {
      return yield* new InvalidControlInput({ message: 'No such admin operation route' })
    }
    if (response.status === 400 || response.status === 422) {
      return yield* new InvalidControlInput({ message: 'Admin endpoint rejected the operation payload' })
    }
    if (response.status >= 500) {
      return yield* new ControlDependencyUnavailable({
        dependency: 'admin-endpoint',
        message: `Admin endpoint answered ${response.status}`,
      })
    }
    return yield* new InvalidControlInput({ message: 'Malformed admin response' })
  })

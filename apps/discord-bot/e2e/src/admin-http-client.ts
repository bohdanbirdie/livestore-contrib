/**
 * HTTPS replica of the Unix-socket BotControlClient facade: one authenticated
 * POST per operation to the Cloudflare admin plane, decoding the exact
 * ControlResult JSON shapes the CLI parses today (see cf/src/admin.ts).
 */
import { Schema } from 'effect'

import type { Snowflake } from './model.ts'

/** Mirrors src/control/schema.ts `ControlResult`. */
const AdminControlResult = Schema.Struct({
  _tag: Schema.Literals(['Success', 'AlreadySatisfied', 'Planned', 'Unrun']),
  summary: Schema.Trimmed.check(Schema.isNonEmpty()),
  correlationId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
  receiptId: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
  nextCommand: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
})

export type AdminControlResult = typeof AdminControlResult.Type

export interface HttpsBotControlClient {
  /** POSTs ThreadCreate to `<endpoint>/admin/rpc/ThreadCreate`. */
  readonly threadCreate: (input: {
    readonly guildId: Snowflake
    readonly channelId: Snowflake
    readonly sourceMessageId: Snowflake
    readonly reason: string
  }) => Promise<AdminControlResult>
}

/** Only these decoded discriminants may cross the receipt boundary. */
export const safeControlTags: Record<string, true> = {
  Success: true,
  AlreadySatisfied: true,
  Planned: true,
  Unrun: true,
  InvalidControlInput: true,
  ControlAuthorizationRejected: true,
  ControlDependencyUnavailable: true,
  ControlApplicationFailure: true,
  ControlAmbiguousOutcome: true,
  ControlGateUnrun: true,
}
export type AdminFailureReason =
  | 'admin-unreachable'
  | 'admin-http-error'
  | 'invalid-control-result'
  | 'control-result-unexpected'

/** The response body is never retained; only status and allowlisted tags survive. */
export class AdminControlFailure extends Error {
  readonly _tag = 'AdminControlFailure'
  readonly reason: AdminFailureReason
  readonly status: number | undefined
  readonly controlResultTag: string | undefined
  readonly serverMessage: string | undefined

  constructor(reason: AdminFailureReason, status?: number, controlResultTag?: string, serverMessage?: string) {
    super(reason)
    this.reason = reason
    this.status = status
    this.controlResultTag = controlResultTag
    this.serverMessage = serverMessage
  }
}

const fixedServerMessages: Record<string, true> = {
  'Requested environment does not match the running bot': true,
  'Requested source is outside the configured guild/channel scope': true,
  'Discord source message does not exist': true,
  'Discord source message could not be read': true,
  'Discord returned a source message that did not match the requested target': true,
  'Existing source thread could not be authoritatively checked': true,
  'Thread request was not authorized': true,
  'Control transport could not prove an authorized operator principal': true,
  'Control transport could not prove an authorized operator principal for this write': true,
}

export const safeServerMessage = (value: unknown): string => {
  if (typeof value !== 'string') return 'other'
  if (Object.hasOwn(fixedServerMessages, value) === true) return value
  const prefixes = [
    'Thread request rejected by policy: ',
    'Thread creation failed: ',
    'Thread outcome requires reconciliation: ',
  ]
  for (const prefix of prefixes) {
    if (value.startsWith(prefix) === true && /^[a-z0-9_:-]{1,64}$/u.test(value.slice(prefix.length)) === true) {
      return value
    }
  }
  return 'other'
}

const safeControlBody = (body: string): { readonly tag?: string; readonly serverMessage: string } => {
  try {
    const decoded: unknown = JSON.parse(body)
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded) === true) {
      return { serverMessage: 'other' }
    }
    const tag =
      '_tag' in decoded && typeof decoded._tag === 'string' && Object.hasOwn(safeControlTags, decoded._tag) === true
        ? decoded._tag
        : undefined
    const message = 'message' in decoded ? decoded.message : undefined
    return {
      ...(tag === undefined ? {} : { tag }),
      serverMessage: safeServerMessage(message),
    }
  } catch {
    return { serverMessage: 'other' }
  }
}

/**
 * The token has exactly one admitted source: the inherited environment
 * populated by the approved wrapper; it is never accepted as a CLI argument.
 */
export const makeHttpsBotControlClient = (input: {
  readonly endpoint: string
  readonly adminToken: string
  readonly fetch?: typeof globalThis.fetch
}): HttpsBotControlClient => {
  const base = input.endpoint.endsWith('/') === true ? input.endpoint.slice(0, -1) : input.endpoint
  const doFetch = input.fetch ?? globalThis.fetch
  return {
    threadCreate: async ({ guildId, channelId, sourceMessageId, reason }) => {
      let response: Response
      try {
        response = await doFetch(`${base}/admin/rpc/ThreadCreate`, {
          method: 'POST',
          headers: { authorization: `Bearer ${input.adminToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            source: { guildId, channelId, messageId: sourceMessageId },
            environment: 'staging',
            apply: true,
            reason,
          }),
        })
      } catch {
        throw new AdminControlFailure('admin-unreachable')
      }
      let body: string
      try {
        body = await response.text()
      } catch {
        throw new AdminControlFailure('admin-http-error', response.status)
      }
      if (response.ok === true) {
        try {
          return Schema.decodeUnknownSync(AdminControlResult)(JSON.parse(body))
        } catch {
          const diagnostic = safeControlBody(body)
          throw new AdminControlFailure('invalid-control-result', response.status, diagnostic.tag)
        }
      }
      const diagnostic = safeControlBody(body)
      throw new AdminControlFailure('admin-http-error', response.status, diagnostic.tag, diagnostic.serverMessage)
    },
  }
}

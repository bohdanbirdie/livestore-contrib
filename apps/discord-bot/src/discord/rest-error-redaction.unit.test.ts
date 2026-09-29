import { Effect, Logger, References } from 'effect'
import * as HttpClientError from 'effect/unstable/http/HttpClientError'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/unstable/http/HttpClientResponse'
import { describe, expect, it, vi } from 'vitest'

import {
  describeDiscordRestFailure,
  discordSafeLogger,
  discordSafeLoggerLayer,
  redactDiscordRestError,
} from './rest-error-redaction.ts'

describe('Discord logger credential boundary', () => {
  it('retains only the numeric Discord error code from a decoded REST failure', () => {
    const raw = Object.assign(new Error('private content and token'), {
      name: 'DiscordRestError',
      _tag: 'ErrorResponse',
      request: { method: 'DELETE', authorization: 'private-token' },
      response: { status: 403 },
      data: { code: 50013, message: 'private message body' },
    })
    const safe = redactDiscordRestError(raw)
    expect(safe).toMatchObject({ method: 'DELETE', status: 403, discordCode: 50013 })
    expect(JSON.stringify(safe)).not.toContain('private')
  })

  it('scrubs DFX 429 debug messages and annotations before output', () => {
    const token = 'FAKE_WEBHOOK_TOKEN_NEVER_LOG_123456'
    const botToken = 'FAKE_BOT_TOKEN_NEVER_LOG_123456'
    const lines: string[] = []
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    try {
      Effect.runSync(
        Effect.logDebug(`429 Authorization: Bot ${botToken}`).pipe(
          Effect.annotateLogs({
            url: `https://discord.com/api/v10/webhooks/123456789012345678/${token}?secret=${token}`,
            callback: `https://discord.com/api/v10/interactions/123456789012345678/${token}/callback`,
            Authorization: `Bot ${botToken}`,
            auth: `Bearer ${botToken}`,
          }),
          Effect.provide(Logger.layer([discordSafeLogger])),
          Effect.provideService(References.MinimumLogLevel, 'Debug'),
        ),
      )
      expect(lines).toHaveLength(1)
      const output = lines.join('')
      expect(output).toContain('/webhooks/123456789012345678/{token}')
      expect(output).toContain('/interactions/123456789012345678/{token}/callback')
      expect(output).toContain('<redacted>')
      expect(output).not.toContain(`secret=${token}`)
      expect(output).not.toContain(token)
      expect(output).not.toContain(botToken)
      expect(output).not.toContain(`Bot ${botToken}`)
    } finally {
      consoleSpy.mockRestore()
    }
  })

  it('sets an Info minimum so DFX Debug is not emitted by default', () => {
    const lines: string[] = []
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    try {
      Effect.runSync(Effect.logDebug('429').pipe(Effect.provide(discordSafeLoggerLayer)))
      Effect.runSync(Effect.logInfo('running').pipe(Effect.provide(discordSafeLoggerLayer)))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('running')
    } finally {
      consoleSpy.mockRestore()
    }
  })
})

it('reports sanitized transport and non-JSON response diagnostics without logging credentials or body', async () => {
  const token = 'SENSITIVE_BOT_TOKEN'
  const request = HttpClientRequest.get('/oauth2/applications/@me').pipe(
    HttpClientRequest.setHeader('Authorization', `Bot ${token}`),
  )
  const transport = new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause: new TypeError(`fetch failed ${token}`) }),
  })
  const transportDetail = await Effect.runPromise(describeDiscordRestFailure(transport, 120))
  expect(transportDetail).toContain('class=HttpClientError reason=TransportError transportCause=TypeError')
  expect(transportDetail).toContain('status=none contentType=none bodyBytes=none elapsedMs=120')
  expect(transportDetail).not.toContain(token)

  const html = '<html>secret response body</html>'
  const response = HttpClientResponse.fromWeb(
    request,
    new Response(html, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } }),
  )
  const decoding = new HttpClientError.HttpClientError({
    reason: new HttpClientError.DecodeError({ request, response, cause: new SyntaxError('invalid HTML') }),
  })
  const responseDetail = await Effect.runPromise(describeDiscordRestFailure(decoding, 250))
  expect(responseDetail).toContain(
    `class=HttpClientError reason=DecodeError transportCause=SyntaxError status=403 contentType=text/html bodyBytes=${html.length} elapsedMs=250`,
  )
  expect(responseDetail).not.toContain(token)
  expect(responseDetail).not.toContain('secret')
})

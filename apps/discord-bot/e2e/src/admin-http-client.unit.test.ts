import { describe, expect, it } from 'vitest'

import { makeHttpsBotControlClient, safeServerMessage } from './admin-http-client.ts'
import type { Snowflake } from './model.ts'

const request = {
  guildId: '111111111111111111' as Snowflake,
  channelId: '222222222222222222' as Snowflake,
  sourceMessageId: '333333333333333333' as Snowflake,
  reason: 'fixture',
}

describe('admin control failure diagnostics', () => {
  it('extracts only the HTTP status and allowlisted ControlResult tag', async () => {
    const client = makeHttpsBotControlClient({
      endpoint: 'https://example.invalid',
      adminToken: 'private-token',
      fetch: async () =>
        new Response(
          JSON.stringify({
            _tag: 'ControlDependencyUnavailable',
            message: 'Authorization: Bearer private-token; source content private',
          }),
          { status: 503 },
        ),
    })
    const failure = await client.threadCreate(request).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({
      reason: 'admin-http-error',
      status: 503,
      controlResultTag: 'ControlDependencyUnavailable',
    })
    expect(failure).toHaveProperty('serverMessage', 'other')
    expect(JSON.stringify(failure)).not.toContain('private-token')
  })

  it('distinguishes unreachable, malformed success, and unrecognized failure bodies', async () => {
    const unreachable = makeHttpsBotControlClient({
      endpoint: 'https://example.invalid',
      adminToken: 'private-token',
      fetch: async () => {
        throw new Error('private-token')
      },
    })
    await expect(unreachable.threadCreate(request)).rejects.toMatchObject({ reason: 'admin-unreachable' })

    const malformed = makeHttpsBotControlClient({
      endpoint: 'https://example.invalid',
      adminToken: 'private-token',
      fetch: async () => new Response(JSON.stringify({ _tag: 'Success', summary: '' }), { status: 200 }),
    })
    await expect(malformed.threadCreate(request)).rejects.toMatchObject({
      reason: 'invalid-control-result',
      status: 200,
      controlResultTag: 'Success',
    })

    const unknown = makeHttpsBotControlClient({
      endpoint: 'https://example.invalid',
      adminToken: 'private-token',
      fetch: async () =>
        new Response(JSON.stringify({ _tag: 'SecretToken', message: 'private-token' }), { status: 502 }),
    })
    const failure = await unknown.threadCreate(request).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ reason: 'admin-http-error', status: 502 })
    expect(failure).toHaveProperty('serverMessage', 'other')
    expect(failure).not.toHaveProperty('controlResultTag', 'SecretToken')
    expect(JSON.stringify(failure)).not.toContain('private-token')
  })
  it.each([
    'Requested environment does not match the running bot',
    'Requested source is outside the configured guild/channel scope',
    'Discord source message does not exist',
    'Discord source message could not be read',
    'Discord returned a source message that did not match the requested target',
    'Existing source thread could not be authoritatively checked',
    'Thread request was not authorized',
    'Control transport could not prove an authorized operator principal',
    'Control transport could not prove an authorized operator principal for this write',
  ])('retains the exact server-owned message %s', (message) => {
    expect(safeServerMessage(message)).toBe(message)
    expect(safeServerMessage(`${message} private-token`)).toBe('other')
  })

  it.each([
    'Thread request rejected by policy: low_information',
    'Thread creation failed: discord_definitive_failure',
    'Thread outcome requires reconciliation: stale_creating',
    'Thread creation failed: timeout:upstream-2',
  ])('retains bounded server-owned code suffixes: %s', (message) => {
    expect(safeServerMessage(message)).toBe(message)
  })

  it('rejects unsafe code suffixes and carries the safe message through an HTTP failure', async () => {
    expect(safeServerMessage(`Thread creation failed: ${'a'.repeat(65)}`)).toBe('other')
    expect(safeServerMessage('Thread creation failed: token SECRET')).toBe('other')
    expect(safeServerMessage('Thread request rejected by policy: x\\nBearer token')).toBe('other')
    const client = makeHttpsBotControlClient({
      endpoint: 'https://example.invalid',
      adminToken: 'private-token',
      fetch: async () =>
        new Response(
          JSON.stringify({
            _tag: 'ControlApplicationFailure',
            message: 'Thread creation failed: discord_definitive_failure',
          }),
          { status: 409 },
        ),
    })
    await expect(client.threadCreate(request)).rejects.toMatchObject({
      reason: 'admin-http-error',
      status: 409,
      controlResultTag: 'ControlApplicationFailure',
      serverMessage: 'Thread creation failed: discord_definitive_failure',
    })
  })
})

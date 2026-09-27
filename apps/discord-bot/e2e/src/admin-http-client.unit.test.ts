import { describe, expect, it } from 'vitest'

import { makeHttpsBotControlClient } from './admin-http-client.ts'
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
    expect(failure).not.toHaveProperty('controlResultTag', 'SecretToken')
    expect(JSON.stringify(failure)).not.toContain('private-token')
  })
})

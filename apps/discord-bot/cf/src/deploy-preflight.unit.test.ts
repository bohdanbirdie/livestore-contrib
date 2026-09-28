import { expect, it } from 'vitest'

import {
  fetchLiveDeploymentIdentity,
  parseLiveDeploymentIdentity,
  preflightRemoteIdentity,
} from './deploy-preflight.ts'
import { admitRemoteIdentity, canonicalProductionIdentity, canonicalStagingIdentity } from './release.ts'

const workerName = 'discordbot-discordbot-staging-fzb2yrs5oh7y4ttr'
const namespaceId = '9fca2fc956e8417c878f89fac50ea207'
const settingsPayload = {
  success: true,
  result: {
    bindings: [
      {
        type: 'durable_object_namespace',
        name: 'BotState',
        class_name: 'BotState',
        namespace_id: namespaceId,
      },
    ],
  },
}

it('extracts the live BotState namespace from Worker settings', () => {
  expect(parseLiveDeploymentIdentity(settingsPayload, workerName)).toEqual({
    workerName,
    botStateNamespaceId: namespaceId,
  })
})

it('fails closed when Worker settings omit the BotState namespace', () => {
  expect(() => parseLiveDeploymentIdentity({ success: true, result: { bindings: [] } }, workerName)).toThrow(
    /no BotState Durable Object namespace/,
  )
})

it('reads identity through the Cloudflare settings endpoint', async () => {
  let requestedUrl: string | undefined
  const observed = await fetchLiveDeploymentIdentity({
    accountId: 'account-id',
    apiToken: 'secret-token',
    workerName,
    fetchImpl: async (input) => {
      requestedUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return Response.json(settingsPayload)
    },
  })
  expect(requestedUrl).toContain(`/workers/scripts/${workerName}/settings`)
  expect(observed.botStateNamespaceId).toBe(namespaceId)
})

it('preserves staging canonical identity and rejects a missing live Worker', async () => {
  await expect(
    preflightRemoteIdentity({
      stage: 'staging',
      allowInitialCreate: false,
      requested: { workerName, botStateNamespaceId: namespaceId },
      accountId: 'account-id',
      apiToken: 'secret-token',
      fetchImpl: async () => new Response('', { status: 404 }),
    }),
  ).rejects.toThrow(/HTTP 404/)
})

it('refuses a second initial production creation once the production identity is pinned', async () => {
  await expect(
    preflightRemoteIdentity({
      stage: 'production',
      allowInitialCreate: true,
      requested: { workerName: 'discordbot-discordbot-production' },
      accountId: 'account-id',
      apiToken: 'secret-token',
      fetchImpl: async () => {
        throw new Error('should not fetch')
      },
    }),
  ).rejects.toThrow(/only before production identity is pinned/)
})

it('pins staging and production identities and requires the production namespace', () => {
  expect(() => admitRemoteIdentity('staging', canonicalStagingIdentity, false)).not.toThrow()
  expect(() =>
    admitRemoteIdentity(
      'staging',
      {
        ...canonicalStagingIdentity,
        botStateNamespaceId: '00000000000000000000000000000000',
      },
      false,
    ),
  ).toThrow(/namespace mismatch/)
  expect(() =>
    admitRemoteIdentity('production', { workerName: canonicalProductionIdentity.workerName }, false),
  ).toThrow(/CF_BOT_STATE_NAMESPACE_ID is required/)
  expect(() => admitRemoteIdentity('production', canonicalProductionIdentity as never, false)).not.toThrow()
  expect(() =>
    admitRemoteIdentity(
      'production',
      { workerName: canonicalProductionIdentity.workerName, botStateNamespaceId: '00000000000000000000000000000000' },
      false,
    ),
  ).toThrow(/namespace mismatch/)
  expect(() => admitRemoteIdentity('production', { workerName: canonicalProductionIdentity.workerName }, true)).toThrow(
    /only before production identity is pinned/,
  )
  expect(() => admitRemoteIdentity('preview', canonicalStagingIdentity, false)).toThrow(/not admitted/)
})

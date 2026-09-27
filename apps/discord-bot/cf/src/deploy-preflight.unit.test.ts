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
      requestedUrl = input.toString()
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

it('admits only an absent canonical production Worker during initial creation', async () => {
  const input = {
    stage: 'production',
    allowInitialCreate: true,
    requested: { workerName: 'discordbot-discordbot-production' },
    accountId: 'account-id',
    apiToken: 'secret-token',
  }
  await expect(
    preflightRemoteIdentity({ ...input, fetchImpl: async () => new Response('', { status: 404 }) }),
  ).resolves.toBeUndefined()
  await expect(
    preflightRemoteIdentity({ ...input, fetchImpl: async () => Response.json(settingsPayload) }),
  ).rejects.toThrow(/absent production Worker/)
  await expect(
    preflightRemoteIdentity({
      ...input,
      stage: 'staging',
      fetchImpl: async () => {
        throw new Error('should not fetch')
      },
    }),
  ).rejects.toThrow(/production-only|only before production/)
  await expect(
    preflightRemoteIdentity({
      ...input,
      requested: { workerName: 'other' },
      fetchImpl: async () => {
        throw new Error('should not fetch')
      },
    }),
  ).rejects.toThrow(/canonical Worker name/)
})

it('pins staging unchanged and refuses unpinned production outside one-time create', () => {
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
  ).toThrow(/not pinned/)
  expect(() =>
    admitRemoteIdentity(
      'production',
      {
        workerName: canonicalProductionIdentity.workerName,
        botStateNamespaceId: '00000000000000000000000000000000',
      },
      true,
    ),
  ).toThrow(/no BotState namespace ID/)
  expect(() => admitRemoteIdentity('preview', canonicalStagingIdentity, false)).toThrow(/not admitted/)
})

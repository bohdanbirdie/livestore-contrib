import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { BotDeploymentConfig, normalizeDeploymentConfig } from './deployment-contract.ts'

const base = {
  schemaVersion: 1 as const,
  environment: 'staging' as const,
  applicationId: '100000000000000010',
  guildId: '100000000000000001',
  actionChannelIds: ['100000000000000002', '100000000000000002'],
  aiTitleChannelIds: ['100000000000000002'],
  docsAudience: {
    publicChannelIds: ['100000000000000002'],
    roleRestrictedChannelIds: [],
    contributorMaintainerRoleIds: [],
  },
  stagingOnlyChannelIds: [],
  botTokenSecretRef: 'op://vault/discord/token',
  openAi: {
    projectId: 'proj_staging',
    serviceAccountSecretRef: 'op://vault/openai/staging',
    retentionPosture: 'standard-store-false' as const,
    limits: {
      requestsPerMemberPerHour: 10,
      requestsPerMinute: 2,
      inputTokensPerRequest: 40_000,
      outputTokensPerRequest: 2_000,
      monthlyCostUsdMicros: 10_000_000,
    },
  },
  releaseId: 'sha256:release',
  diagnostics: {
    sink: 'cloudflare-provider' as const,
    delivery: 'best-effort' as const,
    accessPolicyId: 'cloudflare-access-policy/discord-bot-admin',
    retentionDays: 30,
  },
  e2e: {
    actorApplicationId: '100000000000000011',
    actorTokenSecretRef: 'op://vault/discord/e2e-token',
    targetChannelId: '100000000000000002',
    requiredPurposeMarker: 'livestore-discord-e2e-only',
  },
}

describe('deployment contract', () => {
  it('decodes and canonicalizes action and audience sets', () => {
    const decoded = Schema.decodeSync(BotDeploymentConfig)(base)
    const normalized = normalizeDeploymentConfig(decoded)
    expect(normalized.actionChannelIds).toEqual(['100000000000000002'])
  })

  it.each([
    ['empty actions', { ...base, actionChannelIds: [] }],
    ['AI title outside public audience', { ...base, aiTitleChannelIds: ['100000000000000003'] }],
    [
      'overlapping docs audience',
      { ...base, docsAudience: { ...base.docsAudience, roleRestrictedChannelIds: base.docsAudience.publicChannelIds } },
    ],
    [
      'restricted audience without role',
      { ...base, docsAudience: { ...base.docsAudience, roleRestrictedChannelIds: ['100000000000000003'] } },
    ],
  ])('rejects %s', (_label, value) => {
    const decoded = Schema.decodeSync(BotDeploymentConfig)(value)
    expect(() => normalizeDeploymentConfig(decoded)).toThrow()
  })
  it('accepts production launch with disjoint action channels and empty docs, title, staging, E2E sets', () => {
    const { e2e: _e2e, openAi: _openAi, ...withoutActor } = base
    const config = Schema.decodeSync(BotDeploymentConfig)({
      ...withoutActor,
      environment: 'production',
      actionChannelIds: [
        '1154415662874247191',
        '1344991859805786142',
        '1342877571393781830',
        '1187346072339746828',
        '1374388265741975602',
        '1377647009510723584',
      ],
      aiTitleChannelIds: [],
      stagingOnlyChannelIds: [],
      docsAudience: { publicChannelIds: [], roleRestrictedChannelIds: [], contributorMaintainerRoleIds: [] },
    })
    expect(normalizeDeploymentConfig(config).docsAudience.publicChannelIds).toEqual([])
    expect(config.openAi).toBeUndefined()
    expect(() =>
      normalizeDeploymentConfig(
        Schema.decodeSync(BotDeploymentConfig)({
          ...config,
          docsAudience: { ...config.docsAudience, publicChannelIds: [config.actionChannelIds[0]!] },
        }),
      ),
    ).toThrow(/OpenAI configuration is required/)
  })
})

import * as Config from 'effect/Config'
import * as Schema from 'effect/Schema'

const ReleaseId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)).annotate({
  identifier: 'DiscordBot.ReleaseId',
})

/**
 * Remote deploys must carry immutable build identity. Credential-free local
 * workerd runs deliberately use `dev` when no release was supplied.
 */
export const releaseIdConfig = (local: boolean) => {
  const configured = Config.schema(ReleaseId, 'RELEASE_ID')
  return local === true ? configured.pipe(Config.withDefault('dev')) : configured
}

/** Reads the resolved plain-text Worker binding and fails closed if it drifted. */
export const readReleaseId = (env: Record<string, unknown>): string => {
  const value = env['RELEASE_ID']
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('RELEASE_ID Worker binding is unavailable or empty')
  }
  return value
}

/** Cloudflare's version_metadata binding is absent only in local emulation. */
export const readWorkerVersionId = (env: Record<string, unknown>): string | undefined => {
  const metadata = env['CF_VERSION_METADATA']
  if (typeof metadata !== 'object' || metadata === null) return undefined
  if ('id' in metadata === false) return undefined
  const id = metadata.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

export interface CloudflareDeploymentIdentity {
  readonly workerName: string
  readonly botStateNamespaceId: string
}

export const canonicalStagingIdentity = {
  workerName: 'discordbot-discordbot-staging-fzb2yrs5oh7y4ttr',
  botStateNamespaceId: '9fca2fc956e8417c878f89fac50ea207',
} as const satisfies CloudflareDeploymentIdentity
export const canonicalStagingApplicationId = '1541431832195633232'

// Observed from the first production deploy (2026-09-28, release 9611a96).
export const canonicalProductionIdentity = {
  workerName: 'discordbot-discordbot-production',
  botStateNamespaceId: '02c1287918754225ae1ff48bfeae4d60' as string | undefined,
}

export type RemoteStage = 'staging' | 'production'
export const canonicalIdentityForStage = (stage: RemoteStage) =>
  stage === 'staging' ? canonicalStagingIdentity : canonicalProductionIdentity

export const admitRemoteIdentity = (
  stage: string,
  requested: { readonly workerName: string; readonly botStateNamespaceId?: string },
  allowInitialCreate: boolean,
): void => {
  if (stage !== 'staging' && stage !== 'production') throw new Error(`remote stage ${stage} is not admitted`)
  const canonical = canonicalIdentityForStage(stage)
  if (allowInitialCreate === true) {
    if (stage !== 'production' || canonical.botStateNamespaceId !== undefined) {
      throw new Error('initial create is allowed only before production identity is pinned')
    }
    if (requested.workerName !== canonical.workerName || requested.botStateNamespaceId !== undefined) {
      throw new Error('initial production create requires canonical Worker name and no BotState namespace ID')
    }
    return
  }
  if (canonical.botStateNamespaceId === undefined) throw new Error('production BotState namespace is not pinned yet')
  if (requested.botStateNamespaceId === undefined) throw new Error('CF_BOT_STATE_NAMESPACE_ID is required')
  const mismatch = deploymentIdentityMismatch(
    { workerName: canonical.workerName, botStateNamespaceId: canonical.botStateNamespaceId },
    { workerName: requested.workerName, botStateNamespaceId: requested.botStateNamespaceId },
  )
  if (mismatch !== undefined) throw new Error(mismatch)
}

/** Returns the first identity drift that must abort remote adoption/deploy. */
export const deploymentIdentityMismatch = (
  expected: CloudflareDeploymentIdentity,
  observed: CloudflareDeploymentIdentity,
): string | undefined => {
  if (observed.workerName !== expected.workerName) {
    return `remote Worker identity mismatch: expected ${expected.workerName}, observed ${observed.workerName}`
  }
  if (observed.botStateNamespaceId !== expected.botStateNamespaceId) {
    return `remote BotState namespace mismatch: expected ${expected.botStateNamespaceId}, observed ${observed.botStateNamespaceId}`
  }
  return undefined
}

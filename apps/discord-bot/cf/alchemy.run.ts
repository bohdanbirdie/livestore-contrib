/**
 * Alchemy v2 stack — the single IaC source of truth for the Discord bot.
 * No wrangler.jsonc: everything below is declared here.
 */
import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Output from 'alchemy/Output'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { RetiredHistoricalApplicationId } from '../src/application-commands/model.ts'
import { admitRemoteIdentity, canonicalStagingApplicationId, deploymentIdentityMismatch } from './src/release.ts'
import { DiscordBot } from './src/worker.ts'

export default Alchemy.Stack(
  'DiscordBot',
  {
    providers: Cloudflare.providers(),
    // Shared remote state is mandatory for every remote stage. The only
    // filesystem-state stack is the explicitly local alchemy.local.ts entry.
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    if (process.env['ALCHEMY_LOCAL'] === '1') {
      return yield* Effect.die('remote stack refuses ALCHEMY_LOCAL=1; use alchemy.local.ts')
    }
    const deploymentIdentity = yield* Config.all({
      releaseId: Config.schema(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)), 'RELEASE_ID'),
      workerName: Config.schema(Schema.Trimmed.check(Schema.isNonEmpty()), 'CF_WORKER_NAME'),
      botStateNamespaceId: Config.string('CF_BOT_STATE_NAMESPACE_ID').pipe(Config.option),
    })
    const stage = yield* Alchemy.Stage
    if (stage === 'production' && process.env['CF_DEPLOY_STAGE'] !== 'production') {
      return yield* Effect.die('production requires CF_DEPLOY_STAGE=production before Worker module import')
    }
    if (stage === 'staging' && process.env['CF_DEPLOY_STAGE'] === 'production') {
      return yield* Effect.die('staging cannot use production Worker bindings')
    }
    if (
      stage === 'production' &&
      (process.env['DISCORD_APPLICATION_ID'] === RetiredHistoricalApplicationId ||
        process.env['DISCORD_APPLICATION_ID'] === canonicalStagingApplicationId)
    ) {
      return yield* Effect.die('production Discord application must be distinct from staging and retired applications')
    }
    const bootstrap = process.env['CF_ALLOW_INITIAL_CREATE'] === '1'
    const requestedNamespaceId =
      deploymentIdentity.botStateNamespaceId._tag === 'Some' ? deploymentIdentity.botStateNamespaceId.value : undefined
    yield* Effect.try({
      try: () =>
        admitRemoteIdentity(
          stage,
          {
            workerName: deploymentIdentity.workerName,
            ...(requestedNamespaceId === undefined ? {} : { botStateNamespaceId: requestedNamespaceId }),
          },
          bootstrap,
        ),
      catch: (cause) => cause,
    }).pipe(Effect.orDie)
    if (process.env['CF_WORKER_NAME']?.trim() !== deploymentIdentity.workerName) {
      return yield* Effect.die(
        'CF_WORKER_NAME must be exported in the invoking environment so the Worker name is pinned before resource evaluation',
      )
    }
    const worker = yield* DiscordBot
    const botStateNamespace = worker.durableObjectNamespaces['BotState']
    if (botStateNamespace === undefined) {
      return yield* Effect.die('remote Worker has no BotState Durable Object namespace')
    }
    // Resource outputs are not available while the stack is being declared.
    // Resolve and compare them only after reconciliation, when Alchemy evaluates
    // the stack output against the Worker's actual attributes.
    const verifiedReleaseId = Output.mapEffect(([workerName, botStateNamespaceId]: [string, string]) => {
      const identityMismatch = deploymentIdentityMismatch(
        {
          workerName: deploymentIdentity.workerName,
          botStateNamespaceId: requestedNamespaceId ?? botStateNamespaceId,
        },
        { workerName, botStateNamespaceId },
      )
      return identityMismatch === undefined
        ? Effect.succeed(deploymentIdentity.releaseId)
        : Effect.die(identityMismatch)
    })(Output.all<[Output.Output<string>, Output.Output<string>]>(worker.workerName, botStateNamespace))
    return {
      url: worker.url,
      crons: worker.crons,
      durableObjects: worker.durableObjectNamespaces,
      releaseId: verifiedReleaseId,
    }
  }),
)

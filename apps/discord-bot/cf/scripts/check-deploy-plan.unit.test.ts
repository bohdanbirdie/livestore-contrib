import { describe, expect, it } from 'vitest'

import { checkDeployPlan } from './check-deploy-plan.ts'

const allowed = `Plan: 1 to update
[DiscordBot] update
[DiscordBot/RELEASE_ID] create
[DiscordBot/ADMIN_TOKEN] update
`

describe('Discord bot deploy plan gate', () => {
  it('allows an existing Worker update with binding creates and updates', () => {
    expect(checkDeployPlan(allowed)).toBe(true)
  })

  it.each([
    ['new Worker', 'Plan: 1 to create\n[DiscordBot] create\n'],
    ['new Durable Object', 'Plan: 1 to update, 1 to create\n[DiscordBot] update\n[BotState] create\n'],
    ['replacement', 'Plan: 1 to replace\n[DiscordBot] replace\n'],
    ['deletion', 'Plan: 1 to update, 1 to delete\n[DiscordBot] update\n[Other] delete\n'],
    ['binding deletion', 'Plan: 1 to update\n[DiscordBot] update\n[DiscordBot/ADMIN_TOKEN] delete\n'],
    ['extra resource', 'Plan: 2 to update\n[DiscordBot] update\n[Other] update\n'],
    ['unrecognized plan', 'Plan: no changes\n'],
    ['missing Worker', 'Plan: 1 to update\n[BotState] update\n'],
    ['truncated plan', 'Plan: 2 to update\n[DiscordBot] update\n'],
    ['ambiguous output', `${allowed}${allowed}`],
  ])('rejects %s', (_reason, plan) => {
    expect(() => checkDeployPlan(plan)).toThrow()
  })
})

/** Verbatim row shape of the real first production plan (Alchemy beta.72, 2026-09-28). */
const firstProductionPlan = `Plan: 1 to create
[DiscordBot] create
[DiscordBot/ADMIN_TOKEN] create
[DiscordBot/BotState] create
[DiscordBot/CF_VERSION_METADATA] create
[DiscordBot/Cron(* * * * *)] create
[DiscordBot/DEPLOY_STAGE] create
[DiscordBot/DISCORD_APPLICATION_ID] create
[DiscordBot/DISCORD_BOT_TOKEN] create
[DiscordBot/DOCS_CORRELATION_KEY] create
[DiscordBot/RELEASE_ID] create
`

it('admits precisely the first production Worker with its declared bindings only in bootstrap mode', () => {
  expect(checkDeployPlan(firstProductionPlan, 'production', true)).toBe(true)
  expect(() => checkDeployPlan(firstProductionPlan)).toThrow()
  expect(() => checkDeployPlan(firstProductionPlan, 'staging', true)).toThrow()
  expect(() => checkDeployPlan(allowed, 'production', true)).toThrow()
  expect(() =>
    checkDeployPlan(firstProductionPlan.replace('[DiscordBot/BotState] create\n', ''), 'production', true),
  ).toThrow()
  expect(() =>
    checkDeployPlan(firstProductionPlan + '[DiscordBot/E2E_ACTOR_TOKEN] create\n', 'production', true),
  ).toThrow()
  expect(() =>
    checkDeployPlan(firstProductionPlan.replace('1 to create', '2 to create') + '[Other] create\n', 'production', true),
  ).toThrow()
  expect(() =>
    checkDeployPlan(
      firstProductionPlan.replace('[DiscordBot/DISCORD_BOT_TOKEN] create', '[DiscordBot/DISCORD_BOT_TOKEN] update'),
      'production',
      true,
    ),
  ).toThrow()
})

it('accepts a cron trigger binding row on a Worker update', () => {
  expect(checkDeployPlan(allowed + '[DiscordBot/Cron(* * * * *)] noop\n')).toBe(true)
})

import { readFile } from 'node:fs/promises'

/** Alchemy beta.72 LoggingCli plan rows; reject unknown formats rather than approving an unparsed plan. */
export const checkDeployPlan = (
  text: string,
  stage: 'staging' | 'production' = 'staging',
  allowInitialCreate = false,
): true => {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '')
  if (allowInitialCreate && stage !== 'production') throw new Error('initial create is production-only')
  const summaries = [...plain.matchAll(/^Plan: (.+)$/gm)]
  if (summaries.length !== 1) throw new Error('expected exactly one Alchemy plan summary')
  const summary = summaries[0]?.[1]
  if (summary === undefined || summary === 'no changes') {
    throw new Error('expected an existing Worker plan with explicit resource rows')
  }

  const counts: Record<string, number> = { create: 0, update: 0, replace: 0, delete: 0, noop: 0 }
  for (const part of summary.split(', ')) {
    const match = /^(\d+) to (create|update|replace|delete|noop)$/.exec(part)
    if (match === null || counts[match[2]!] !== 0) throw new Error('unrecognized plan summary')
    counts[match[2]!] = Number(match[1])
  }
  if (counts.replace !== 0 || counts.delete !== 0) throw new Error('plan contains replace or delete actions')

  const rows = [...plain.matchAll(/^\[([^\]\n]+)\] (create|update|replace|delete|noop)(?: \([^\n)]*\))*$/gm)]
  const resourceRows = rows.filter((row) => !row[1]!.includes('/'))
  if (resourceRows.length !== Object.values(counts).reduce((sum, count) => sum + count, 0)) {
    throw new Error('plan resource rows do not match the summary')
  }
  if (rows.filter((row) => row[1] === 'DiscordBot').length !== 1) {
    throw new Error('plan must identify the existing DiscordBot Worker')
  }
  if (allowInitialCreate) {
    if (
      resourceRows.length !== 2 ||
      resourceRows.some((row) => (row[1] !== 'DiscordBot' && row[1] !== 'BotState') || row[2] !== 'create') ||
      rows.filter((row) => row[1] === 'BotState').length !== 1 ||
      counts.create !== 2 ||
      counts.update !== 0 ||
      counts.noop !== 0
    ) {
      throw new Error('initial production plan must create exactly Worker and BotState')
    }
  }
  for (const row of rows) {
    const id = row[1]!
    const action = row[2]!
    if (id === 'DiscordBot' || id === 'BotState') {
      if (allowInitialCreate ? action !== 'create' : action !== 'update' && action !== 'noop') {
        throw new Error(`top-level resource ${id} cannot ${action}`)
      }
    } else if (id.startsWith('DiscordBot/') && /^[A-Za-z0-9_-]+$/.test(id.slice('DiscordBot/'.length))) {
      if (allowInitialCreate ? action !== 'create' : action !== 'create' && action !== 'update' && action !== 'noop') {
        throw new Error(`binding ${id} cannot ${action}`)
      }
    } else {
      throw new Error(`unexpected plan resource ${id}`)
    }
  }
  // Reject unparsed action rows, including a new CLI format that our row parser does not understand.
  const actionLines = plain.split('\n').filter((line) => /^\[.+\] (?:create|update|replace|delete|noop)\b/.test(line))
  if (actionLines.length !== rows.length) throw new Error('unrecognized plan action row')
  return true
}

if (import.meta.main) {
  const [path, stageFlag, stage, bootstrapFlag] = process.argv.slice(2)
  if (
    path === undefined ||
    (stageFlag !== undefined && stageFlag !== '--stage') ||
    (stageFlag === '--stage' && stage !== 'staging' && stage !== 'production') ||
    (bootstrapFlag !== undefined && bootstrapFlag !== '--allow-initial-create') ||
    process.argv.length > 6
  ) {
    throw new Error('usage: check-deploy-plan.ts <plan-log> [--stage staging|production [--allow-initial-create]]')
  }
  await checkDeployPlan(await readFile(path, 'utf8'), stage ?? 'staging', bootstrapFlag === '--allow-initial-create')
  console.log('Discord bot plan gate passed')
}

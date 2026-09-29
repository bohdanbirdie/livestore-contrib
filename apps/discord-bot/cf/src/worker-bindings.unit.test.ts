import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, it } from 'vitest'

const source = readFileSync(resolve(import.meta.dirname, './worker.ts'), 'utf8')

// A secret the Worker reads at runtime but no longer declares would make the
// next deploy delete its Cloudflare binding (the plan shows `[DiscordBot/X] delete`).
it('declares a secret binding for every secret the Worker reads', () => {
  const read = new Set([...source.matchAll(/readSecret\(env, '([A-Z_]+)'\)/g)].map((match) => match[1]))
  const declared = new Set([...source.matchAll(/([A-Z_]+): Config\.redacted\('\1'\)/g)].map((match) => match[1]))
  expect(read.size).toBeGreaterThan(0)
  expect([...read].filter((name) => declared.has(name) === false)).toEqual([])
})

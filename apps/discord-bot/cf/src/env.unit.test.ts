import * as Redacted from 'effect/Redacted'
import { expect, it } from 'vitest'

import { readOptionalBinding, readSecret } from './env.ts'

it('reads plain, Alchemy-marker, and Redacted bindings to their string value', () => {
  const env = {
    PLAIN: 'value',
    MARKER: JSON.stringify({ _tag: 'Redacted', value: '1553674978757451776' }),
    REDACTED: Redacted.make('secret'),
    JSONISH: '{"not":"a marker"}',
  }
  expect(readSecret(env, 'PLAIN')).toBe('value')
  expect(readSecret(env, 'MARKER')).toBe('1553674978757451776')
  expect(readSecret(env, 'REDACTED')).toBe('secret')
  expect(readSecret(env, 'JSONISH')).toBe('{"not":"a marker"}')
  expect(readOptionalBinding(env, 'MISSING')).toBeUndefined()
  expect(() => readSecret(env, 'MISSING')).toThrow('not available')
})

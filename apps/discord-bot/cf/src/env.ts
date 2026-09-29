import * as Redacted from 'effect/Redacted'

/**
 * Alchemy binds `Config` values as `secret_text` holding a JSON marker
 * (`{"_tag":"Redacted","value":…}`); a binding the runtime module does not
 * re-declare arrives as that raw marker string. Unwrap it like Alchemy's own
 * config provider does, and pass every other string through unchanged.
 */
const unwrapBoundString = (raw: string): string => {
  if (raw.startsWith('{') === false) return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && (parsed as { _tag?: unknown })._tag === 'Redacted') {
      const value = (parsed as { value?: unknown }).value
      return typeof value === 'string' ? value : JSON.stringify(value)
    }
  } catch {
    // Not a marker: an ordinary string that happens to start with `{`.
  }
  return raw
}

/**
 * Secret bindings arrive as plain strings (local dev), raw Alchemy marker
 * strings, or Redacted values; all collapse to their string value.
 */
export const readSecret = (env: Record<string, unknown>, key: string): string => {
  const value = env[key]
  if (typeof value === 'string') return unwrapBoundString(value)
  // Alchemy's deploy phase evaluates the DO init with placeholder bindings
  // that are neither strings nor Redacted values; fail loudly instead of
  // crashing inside Redacted internals.
  if (Redacted.isRedacted(value) === false) {
    throw new Error(`secret binding ${key} is not available in this phase`)
  }
  return String(Redacted.value(value))
}

/** Optional plain or Config-bound string binding; `undefined` when absent. */
export const readOptionalBinding = (env: Record<string, unknown>, key: string): string | undefined => {
  const value = env[key]
  if (value === undefined || value === null) return undefined
  return readSecret(env, key)
}

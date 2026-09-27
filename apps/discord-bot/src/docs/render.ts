import type { DocsQueryResult } from './domain.ts'

export const renderDocsResult = (result: DocsQueryResult) => {
  switch (result._tag) {
    case 'Answered': {
      const sources = result.citations.map(({ id, canonicalUrl }) => `- [${id}](${canonicalUrl})`).join('\n')
      return `${result.answer}\n\nSources:\n${sources}`
    }
    case 'Unsupported':
      return result.explanation
    case 'Unavailable':
      return unavailableMessage(result.reason)
  }
}

export interface DiscordRenderingBounds {
  readonly maximumMessageCharacters: number
  readonly maximumMessages: number
}

export const defaultDiscordRenderingBounds: DiscordRenderingBounds = {
  maximumMessageCharacters: 1_900,
  maximumMessages: 8,
}

export type DiscordRenderingResult =
  | { readonly _tag: 'Rendered'; readonly messages: readonly [string, ...ReadonlyArray<string>] }
  | {
      readonly _tag: 'RenderingFailed'
      readonly reason: 'unclosed_code_fence' | 'unsplittable_line' | 'too_many_messages'
    }

/** Splits transport text while closing and reopening fenced blocks at message boundaries. */
export const renderDocsMessages = (
  result: DocsQueryResult,
  bounds: DiscordRenderingBounds = defaultDiscordRenderingBounds,
): DiscordRenderingResult => {
  const text = renderDocsResult(result)
  const messages: Array<string> = []
  let current = ''
  let fenceOpening: string | undefined

  const flush = () => {
    if (current.length === 0) return
    messages.push(current)
    current = fenceOpening === undefined ? '' : `${fenceOpening}\n`
  }

  for (const line of text.split('\n')) {
    const isFenceDelimiter = line.startsWith('```')
    const closesFence = isFenceDelimiter === true && fenceOpening !== undefined
    const reserve = fenceOpening === undefined || closesFence === true ? 0 : 4
    const separator = current.length === 0 ? '' : '\n'

    if (current.length + separator.length + line.length > bounds.maximumMessageCharacters - reserve) {
      if (fenceOpening !== undefined) current += '\n```'
      flush()
    }

    const nextSeparator = current.length === 0 ? '' : '\n'
    if (current.length + nextSeparator.length + line.length > bounds.maximumMessageCharacters) {
      return { _tag: 'RenderingFailed', reason: 'unsplittable_line' }
    }
    current += `${nextSeparator}${line}`

    if (isFenceDelimiter === true) {
      if (closesFence === true) fenceOpening = undefined
      else fenceOpening = line
    }
  }

  if (fenceOpening !== undefined) return { _tag: 'RenderingFailed', reason: 'unclosed_code_fence' }
  flush()
  const [first, ...rest] = messages
  if (first === undefined) return { _tag: 'RenderingFailed', reason: 'unsplittable_line' }
  if (messages.length > bounds.maximumMessages) return { _tag: 'RenderingFailed', reason: 'too_many_messages' }
  return { _tag: 'Rendered', messages: [first, ...rest] }
}

/** User-facing texts for docs results that are not answers (also used by the E2E broker to classify replies). */
export const docsUnavailableMessages = {
  invalid_query:
    'Please provide a LiveStore documentation question, for example `/docs query:How do I define an event?`.',
  admission_denied: 'The documentation assistant is temporarily at its usage limit. Please try again later.',
  corpus_unavailable: 'The LiveStore documentation corpus is temporarily unavailable. Please try again later.',
  no_answer: 'The documentation assistant could not produce a source-backed answer. Please try again later.',
} as const

const unavailableMessage = (reason: Extract<DocsQueryResult, { readonly _tag: 'Unavailable' }>['reason']) => {
  switch (reason) {
    case 'invalid_query':
      return docsUnavailableMessages.invalid_query
    case 'admission_denied':
      return docsUnavailableMessages.admission_denied
    case 'corpus_unavailable':
      return docsUnavailableMessages.corpus_unavailable
    case 'provider_unavailable':
    case 'invalid_provider_output':
    case 'invalid_citation':
      return docsUnavailableMessages.no_answer
  }
}

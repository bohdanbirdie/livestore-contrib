import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { docsUnavailableMessages } from '../../src/docs/render.ts'
import { docsNotConfiguredMessage, threadPermissionDeniedMessage } from '../../src/runtime/handlers.ts'
import type { AttendedBrokerDriver, GestureEvidence } from './attended-broker.ts'

// Observed in the official Discord web client on 2026-09-26. The message
// toolbar appears after clicking the message article; no hover is required.
export const gestureLocators = {
  composer: {
    locator: { kind: 'css', selector: '[role="textbox"][aria-label^="Message #"]' },
    calibrated: '2026-09-26',
  },
  messageRow: {
    selector: 'li[id^="chat-messages-"]',
    calibrated: '2026-09-26',
  },
  moreButton: { locator: { kind: 'role', role: 'button', name: 'More' }, calibrated: '2026-09-26' },
  apps: { locator: { kind: 'role', role: 'menuitem', name: 'Apps' }, calibrated: '2026-09-26' },
  app: {
    locator: { kind: 'role', role: 'menuitem', name: 'LiveStore Auto Threads Staging' },
    calibrated: '2026-09-26',
  },
  createThread: {
    locator: {
      kind: 'within',
      scope: {
        kind: 'css',
        selector: '[role="menu"][aria-activedescendant^="message-actions-apps--"]:not(:has([role="menu"]))',
      },
      target: { kind: 'role', role: 'menuitem', name: 'Create Thread' },
    },
    calibrated: '2026-09-26',
  },
  messageIdAttribute: {
    selector: 'li[id^="chat-messages-"]',
    attribute: 'id',
    calibrated: '2026-09-26',
  },
} as const

type Locator =
  | { readonly kind: 'role'; readonly role: string; readonly name: string }
  | { readonly kind: 'css'; readonly selector: string }
  | { readonly kind: 'within'; readonly scope: Locator; readonly target: Locator }

type BrowserOperation =
  | { readonly kind: 'navigate'; readonly url: string; readonly intent: string; readonly effect: 'read' }
  | { readonly kind: 'wait'; readonly locator: Locator; readonly state: 'visible'; readonly timeoutMs: number }
  | { readonly kind: 'click'; readonly locator: Locator; readonly intent: string; readonly effect: 'read' | 'write' }
  | {
      readonly kind: 'press'
      readonly locator: Locator
      readonly key: 'Enter'
      readonly intent: string
      readonly effect: 'write'
    }
  | {
      readonly kind: 'fill' | 'type'
      readonly locator: Locator
      readonly valueSource: 'stdin'
      readonly intent: string
      readonly effect: 'write'
    }
  | { readonly kind: 'evaluate'; readonly expression: string }

/** Only fill/type carries a value, out of the request file and into stdin. */
export type BrowserControlStep = { readonly operation: BrowserOperation; readonly stdinValue?: string }

export interface HttpCaptureDriverInput {
  readonly maintainerSessionId?: string
  readonly memberSessionId?: string
}
export class CaptureGestureFailure extends Error {
  readonly operation: BrowserOperation['kind']
  readonly exitCode: number | undefined
  readonly step: number | undefined
  /** HTTP Capture's fixed browser-control error code, e.g. `browser_unavailable`. */
  readonly code: string | undefined

  constructor(operation: BrowserOperation['kind'], exitCode: number | undefined, step?: number, code?: string) {
    super(`Capture ${operation} failed`)
    this.operation = operation
    this.exitCode = exitCode
    this.step = step
    this.code = code
  }
}

/**
 * HTTP Capture fences each browser step to one document generation and answers
 * `browser_unavailable` when Discord's SPA replaces the document mid-step (it
 * does so after a navigation, and slower under host load). Re-running a
 * read-only step against the settled document is correct; write steps are
 * never retried because their effect may already have landed.
 */
export const runReadStepAcrossDocumentReplacement = async <A>(
  step: BrowserControlStep,
  run: () => Promise<A>,
  maxAttempts = 3,
): Promise<A> => {
  const readOnly =
    step.operation.kind === 'evaluate' ||
    step.operation.kind === 'wait' ||
    (step.operation.kind === 'navigate' && step.operation.effect === 'read')
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (
        readOnly === false ||
        attempt >= maxAttempts ||
        !(error instanceof CaptureGestureFailure) ||
        error.code !== 'browser_unavailable'
      )
        throw error
    }
  }
}

const composer = gestureLocators.composer.locator
const markedRow = (marker: string): Locator => ({
  kind: 'css',
  selector: `${gestureLocators.messageRow.selector}:has-text(${JSON.stringify(marker)})`,
})
const withinRow = (marker: string, target: Locator): Locator => ({ kind: 'within', scope: markedRow(marker), target })
const channelUrl = (guildId: string, channelId: string) => `https://discord.com/channels/${guildId}/${channelId}`
const navigate = (guildId: string, channelId: string): BrowserControlStep => ({
  operation: {
    kind: 'navigate',
    url: channelUrl(guildId, channelId),
    intent: 'Open selected staging channel',
    effect: 'read',
  },
})
const click = (locator: Locator, intent: string, effect: 'read' | 'write' = 'read'): BrowserControlStep => ({
  operation: { kind: 'click', locator, intent, effect },
})
const fill = (locator: Locator, value: string): BrowserControlStep => ({
  operation: { kind: 'fill', locator, valueSource: 'stdin', intent: 'Enter attended staging gesture', effect: 'write' },
  stdinValue: value,
})
const send = (locator: Locator): BrowserControlStep => ({
  operation: { kind: 'press', locator, key: 'Enter', intent: 'Submit attended staging gesture', effect: 'write' },
})
const ready = (locator: Locator): BrowserControlStep => ({
  operation: { kind: 'wait', locator, state: 'visible', timeoutMs: 15_000 },
})

export const buildCreateMessageSteps = (input: {
  readonly guildId: string
  readonly channelId: string
  readonly content: string
}): ReadonlyArray<BrowserControlStep> => [
  navigate(input.guildId, input.channelId),
  ready(composer),
  fill(composer, input.content),
  send(composer),
]

export const buildDocsCommandSteps = (input: {
  readonly guildId: string
  readonly channelId: string
  readonly query: string
}): ReadonlyArray<BrowserControlStep> => [
  navigate(input.guildId, input.channelId),
  ready(composer),
  // One fill of the full invocation: Discord parses it into the command with its `query`
  // option (calibrated 2026-09-27). Choosing the listbox option and then entering text
  // cancels the command, because capture text entry replaces the composer content.
  fill(composer, `/docs query:${input.query}`),
  send(composer),
]

export const buildMessageActionSteps = (input: {
  readonly guildId: string
  readonly channelId: string
  readonly sourceMarkerText: string
}): ReadonlyArray<BrowserControlStep> => [
  navigate(input.guildId, input.channelId),
  ready(markedRow(input.sourceMarkerText)),
  click(markedRow(input.sourceMarkerText), 'Reveal marked message actions'),
  click(withinRow(input.sourceMarkerText, gestureLocators.moreButton.locator), 'Open marked message menu'),
  click(gestureLocators.apps.locator, 'Open Apps submenu'),
  click(gestureLocators.app.locator, 'Open LiveStore Auto Threads Staging commands'),
  click(gestureLocators.createThread.locator, 'Invoke Create Thread action', 'write'),
]

/** Only the fixed `error.code` token leaves the CLI output; messages may quote page evidence. */
const captureErrorCode = (stdout: string): string | undefined => {
  try {
    const decoded: unknown = JSON.parse(stdout)
    if (typeof decoded !== 'object' || decoded === null || !('error' in decoded)) return undefined
    const error = decoded.error
    if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string')
      return undefined
    return /^[a-z_]{1,64}$/u.test(error.code) === true ? error.code : undefined
  } catch {
    return undefined
  }
}

const runBrowserStep = (sessionId: string, step: BrowserControlStep, stepIndex?: number): Promise<unknown> =>
  runReadStepAcrossDocumentReplacement(step, () => runBrowserStepOnce(sessionId, step, stepIndex))

const runBrowserStepOnce = async (
  sessionId: string,
  step: BrowserControlStep,
  stepIndex?: number,
): Promise<unknown> => {
  const directory = await mkdtemp(join(tmpdir(), 'discord-e2e-capture-'))
  const requestFile = join(directory, 'request.json')
  try {
    await writeFile(requestFile, JSON.stringify(step.operation), { mode: 0o600 })
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const child = spawn('http-capture', ['browser', step.operation.kind, sessionId, '--request', requestFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.resume() // never display private page evidence or fill values
    child.on('error', () => reject(new CaptureGestureFailure(step.operation.kind, undefined, stepIndex)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new CaptureGestureFailure(step.operation.kind, code ?? undefined, stepIndex, captureErrorCode(stdout)))
        return
      }
      try {
        const result: unknown = JSON.parse(stdout)
        if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) {
          reject(new CaptureGestureFailure(step.operation.kind, 0, stepIndex, captureErrorCode(stdout)))
        } else resolve(result)
      } catch {
        reject(new CaptureGestureFailure(step.operation.kind, 0, stepIndex))
      }
    })
    // v2 reads only fill/type values from stdin. Do not log either stream.
    child.stdin.end(step.stdinValue)
    return await promise
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

type MessageRow = { readonly id: string; readonly text: string }

/**
 * Interaction replies are deferred (a "thinking" row that is later edited), so read the
 * history until a new app-authored row has settled or the deadline passes. Reading once
 * can classify the placeholder, which shows the source preview but not the outcome.
 */
export const settledAppReplies = async (
  readMessages: () => Promise<ReadonlyArray<MessageRow>>,
  before: ReadonlyArray<MessageRow>,
  options: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<ReadonlyArray<MessageRow>> => {
  const deadline = Date.now() + (options.timeoutMs ?? 90_000)
  for (;;) {
    const rows = await readMessages()
    const settled = rows.some(
      (row) =>
        before.every((old) => old.id !== row.id) &&
        row.text.includes(gestureLocators.app.locator.name) &&
        /is thinking|sending command/iu.test(row.text) === false,
    )
    if (settled === true || Date.now() >= deadline) return rows
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 3_000))
  }
}

/** v2 command fetches health.control.epoch at invocation time and fences the envelope itself. */
export const makeHttpCaptureBrokerDriver = (input: HttpCaptureDriverInput = {}): AttendedBrokerDriver => ({
  perform: async ({ operation, request }): Promise<GestureEvidence> => {
    const identity =
      operation === 'invoke-docs' &&
      typeof request === 'object' &&
      request !== null &&
      'persona' in request &&
      request.persona === 'member' &&
      'location' in request &&
      request.location === 'restricted'
        ? 'member'
        : 'maintainer'
    const sessionId =
      identity === 'member'
        ? (process.env.LIVESTORE_DISCORD_E2E_CAPTURE_SESSION_MEMBER ?? input.memberSessionId)
        : (process.env.LIVESTORE_DISCORD_E2E_CAPTURE_SESSION_MAINTAINER ?? input.maintainerSessionId)
    if (
      sessionId === undefined ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(sessionId) === false
    )
      return { declined: true }
    if (typeof request !== 'object' || request === null || Array.isArray(request) === true)
      throw new Error('invalid gesture request')
    const record = request as Record<string, unknown>
    const required = (key: string): string => {
      const value = record[key]
      if (typeof value !== 'string' || value.length === 0) throw new Error(`gesture request missing ${key}`)
      return value
    }
    const guildId = required('guildId')
    const channelId = required('channelId')
    let steps: ReadonlyArray<BrowserControlStep>
    switch (operation) {
      case 'create-message':
        steps = buildCreateMessageSteps({ guildId, channelId, content: required('content') })
        break
      case 'invoke-docs':
        steps = buildDocsCommandSteps({ guildId, channelId, query: required('query') })
        break
      case 'invoke-message-action':
        steps = buildMessageActionSteps({ guildId, channelId, sourceMarkerText: required('marker') })
        break
      default:
        throw new Error(`unknown broker operation: ${operation}`)
    }
    // v2 effect receipts have only {kind:'completed'}; never interpret one as
    // a response, deletion proof, or Discord message ID.
    const readMessages = async (): Promise<ReadonlyArray<{ id: string; text: string }>> => {
      const expression = `Array.from(document.querySelectorAll('${gestureLocators.messageIdAttribute.selector}')).map(function(e){return {id:e.getAttribute('${gestureLocators.messageIdAttribute.attribute}').match(/-(\\d{17,20})$/)?.[1],text:(e.textContent??'').slice(0,2048)}}).filter(function(e){return e.id!==undefined})`
      const response = await runBrowserStep(sessionId, { operation: { kind: 'evaluate', expression } })
      if (
        typeof response !== 'object' ||
        response === null ||
        !('result' in response) ||
        typeof response.result !== 'object' ||
        response.result === null ||
        !('value' in response.result) ||
        Array.isArray(response.result.value) === false
      )
        throw new CaptureGestureFailure('evaluate', 0)
      return response.result.value as ReadonlyArray<{ id: string; text: string }>
    }
    await runBrowserStep(sessionId, steps[0]!, 0)
    // Read the history only once the channel view has rendered its composer.
    await runBrowserStep(sessionId, ready(composer), 0)
    // Posting a message needs no history: the correlator proves it over REST. Only interaction
    // replies (ephemeral, invisible to REST) are read from the page.
    if (operation === 'create-message') {
      for (let index = 1; index < steps.length; index++) await runBrowserStep(sessionId, steps[index]!, index)
      return {}
    }
    const before = await readMessages()
    if (
      operation === 'invoke-message-action' &&
      before.some((item) => item.id === required('sourceMessageId') && item.text.includes(required('marker'))) === false
    )
      return { declined: true }
    for (let index = 1; index < steps.length; index++) await runBrowserStep(sessionId, steps[index]!, index)
    const after = await settledAppReplies(readMessages, before)
    const marker = required('marker')
    // Docs replies do not echo the query, so they are the new rows authored by the app;
    // any new row carrying the marker is the invoker's own text, never a reply.
    const newResponses = after.filter(
      (item) =>
        before.every((old) => old.id !== item.id) &&
        (operation === 'invoke-docs'
          ? item.text.includes(gestureLocators.app.locator.name) && item.text.includes(marker) === false
          : item.text.includes(gestureLocators.app.locator.name) || item.text.includes(marker)),
    )
    const responseMessageIds = newResponses.map((item) => item.id)
    if (responseMessageIds.length === 0) return { declined: true }
    return {
      ...classifyReplies(
        operation,
        newResponses.map((item) => item.text),
      ),
      responseMessageIds,
    }
  },
})

/** Classifies bot replies by the bot's own user-facing texts; a non-answer never counts as answered. */
export const classifyReplies = (
  operation: 'invoke-docs' | 'invoke-message-action',
  texts: ReadonlyArray<string>,
): Pick<GestureEvidence, 'docsOutcome' | 'messageActionOutcome'> => {
  if (operation === 'invoke-message-action')
    return {
      messageActionOutcome:
        texts.some((text) => text.includes(threadPermissionDeniedMessage)) === true ? 'denied' : 'created',
    }
  if (texts.some((text) => text.includes(docsNotConfiguredMessage)) === true) return { docsOutcome: 'denied' }
  if (texts.some((text) => Object.values(docsUnavailableMessages).some((message) => text.includes(message))) === true)
    throw new Error('docs reply was an unavailable notice, not an answer')
  return { docsOutcome: 'answered' }
}

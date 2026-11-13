/**
 * Session-log usage scanning.
 *
 * The harness persists each session log through `ctx.sessionPersistence`; every
 * completed model request writes an `assistant/message` event whose `usage`
 * carries token counts, and a summarization call writes `compaction/summary`
 * with its own route and usage. This module replays those logs and prices them
 * with `pricing.js` to produce the two estimates the widget shows:
 *
 *   - the current day's spend across every stored session (subagents included);
 *   - the current session's spend for the whole session lifetime.
 *
 * Fork-inherited prefixes are skipped: a seeded session log starts with a copy
 * of the parent's events, and counting them twice would inflate the day total.
 *
 * Only requests routed through the DeepSeek platform are priced; requests to
 * other providers (local ollama, free third-party gateways) never touch the
 * platform balance. They are excluded from the cost and counted separately as
 * `otherCalls`/`otherTokens` so the widget can say why a spend is zero.
 *
 * Day totals are cached per session revision and per calendar day, so a
 * repeated overview request only re-reads sessions whose log changed since the
 * previous scan, and a midnight rollover re-aggregates the cached per-day
 * buckets instead of re-reading the whole corpus.
 */

import { costOf, isDeepSeekRoute } from './pricing.js'

const DAY_TTL_MS = 120_000
const SESSION_TTL_MS = 30_000
const DAY_MS = 86_400_000
const KEEP_DAYS = 3

function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * Local calendar day key (YYYY-MM-DD) for one instant.
 *
 * @param {number} timeMs - Unix epoch milliseconds.
 * @returns {string} local day key.
 */
export function localDayKey(timeMs) {
  const date = new Date(timeMs)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function countOf(value) {
  if (value === undefined || value === null) return 0
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function usageOf(event) {
  const usage = event?.data?.usage
  if (usage === undefined || usage === null) return null
  const time = Number(event.time)
  if (!Number.isFinite(time)) return null
  const input = countOf(usage.inputTokens)
  const output = countOf(usage.outputTokens)
  const cache = countOf(usage.cacheReadTokens)
  if (input === null || output === null || cache === null) return null
  return { time, input, output, cache }
}

/**
 * Fold one session's events into per-request usage callbacks.
 *
 * The route comes from the most recent `request/header`; a summary call carries
 * its own provider/model in the event payload. A missing route keeps the
 * previous one, exactly like the request loop does.
 *
 * @param {ReadonlyArray<any>} events - session events (own work only).
 * @param {(usage: { time: number, provider: string, model: string, input: number, output: number, cache: number }) => void} onUsage - per-request callback.
 * @returns {number} number of folded usage records.
 */
export function foldUsageEvents(events, onUsage) {
  let provider = ''
  let model = ''
  let count = 0
  for (const event of events ?? []) {
    const type = event?.type
    if (type === 'request/header') {
      const config = event.data?.header?.config
      if (config !== undefined && config !== null) {
        if (typeof config.provider === 'string') provider = config.provider
        if (typeof config.model === 'string') model = config.model
      }
      continue
    }
    if (type === 'assistant/message') {
      const usage = usageOf(event)
      if (usage === null) continue
      onUsage({ ...usage, provider, model })
      count += 1
      continue
    }
    if (type === 'compaction/summary') {
      const usage = usageOf(event)
      if (usage === null) continue
      const data = event.data ?? {}
      const summaryProvider = typeof data.provider === 'string' && data.provider !== '' ? data.provider : provider
      const summaryModel = typeof data.model === 'string' && data.model !== '' ? data.model : model
      if (summaryProvider !== '') provider = summaryProvider
      if (summaryModel !== '') model = summaryModel
      onUsage({ ...usage, provider: summaryProvider, model: summaryModel })
      count += 1
    }
  }
  return count
}

/**
 * Read a session's own events, skipping its fork-inherited prefix.
 *
 * @param {any} persistence - `ctx.sessionPersistence` service.
 * @param {string} sessionId - session id.
 * @returns {Promise<ReadonlyArray<any>>} own events in log order.
 */
export async function readOwnSessionEvents(persistence, sessionId) {
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(sessionId, 'read')
    try {
      const inheritedRaw = Number(handle.inheritedEventCount ?? 0)
      let offset = Number.isFinite(inheritedRaw) && inheritedRaw > 0 ? inheritedRaw : 0
      if (typeof handle.read !== 'function') {
        if (typeof persistence.readFrom !== 'function') {
          throw new Error('sessionPersistence не поддерживает ни open().read(), ни readFrom()')
        }
        const { events } = await persistence.readFrom(sessionId, 0)
        return (Array.isArray(events) ? events : []).slice(offset)
      }
      const events = []
      for (;;) {
        const slice = await handle.read(offset)
        const batch = Array.isArray(slice?.events) ? slice.events : []
        if (batch.length === 0) return events
        for (const event of batch) events.push(event)
        const lastSeq = Number(batch[batch.length - 1]?.seq)
        offset = Number.isFinite(lastSeq) ? lastSeq + 1 : offset + batch.length
      }
    } finally {
      try {
        await handle.close()
      } catch {
        // A close failure must not hide the events already read.
      }
    }
  }
  if (typeof persistence.readFrom !== 'function') {
    throw new Error('sessionPersistence не поддерживает ни open(), ни readFrom()')
  }
  const { events } = await persistence.readFrom(sessionId, 0)
  return Array.isArray(events) ? events : []
}

function sessionIdOf(snapshot) {
  const id = snapshot?.header?.id ?? snapshot?.id ?? snapshot?.sessionId ?? snapshot?.header?.sessionId
  return typeof id === 'string' && id !== '' ? id : null
}

function revisionKeyOf(snapshot) {
  const revision = snapshot?.revision
  if (typeof revision === 'string') return revision
  if (revision === undefined || revision === null) return ''
  try {
    return JSON.stringify(revision)
  } catch {
    return ''
  }
}

function emptyBucket() {
  return { costCNY: 0, calls: 0, tokens: 0, otherCalls: 0, otherTokens: 0 }
}

/**
 * Create a usage scanner bound to one session-persistence service.
 *
 * @param {any} persistence - `ctx.sessionPersistence` service.
 * @returns {{
 *   day: (nowMs?: number) => Promise<object>,
 *   session: (sessionId: string, options?: number | { nowMs?: number, force?: boolean }) => Promise<object>,
 * }} scanner.
 */
export function createUsageScanner(persistence) {
  /** @type {Map<string, { revisionKey: string, buckets: Map<string, { costCNY: number, calls: number, tokens: number }> }>} */
  const sessionCache = new Map()
  /** @type {Map<string, { at: number, result: object }>} */
  const detailedCache = new Map()
  let dayCache = null

  async function snapshots() {
    const listed = await persistence.list()
    const rows = []
    for (const snapshot of Array.isArray(listed) ? listed : []) {
      const id = sessionIdOf(snapshot)
      if (id === null) continue
      rows.push({ id, revisionKey: revisionKeyOf(snapshot) })
    }
    return rows
  }

  function pruneBuckets(buckets, nowMs) {
    const keepFrom = localDayKey(nowMs - KEEP_DAYS * DAY_MS)
    for (const key of buckets.keys()) if (key < keepFrom) buckets.delete(key)
  }

  function foldIntoBuckets(events, buckets) {
    foldUsageEvents(events, (usage) => {
      const dayKey = localDayKey(usage.time)
      let bucket = buckets.get(dayKey)
      if (bucket === undefined) {
        bucket = emptyBucket()
        buckets.set(dayKey, bucket)
      }
      const tokens = usage.input + usage.output + usage.cache
      if (isDeepSeekRoute(usage.provider, usage.model)) {
        bucket.costCNY += costOf(usage.time, usage.model, usage.input, usage.cache, usage.output)
        bucket.tokens += tokens
        bucket.calls += 1
      } else {
        // Another provider: it does not spend the DeepSeek platform balance.
        bucket.otherTokens += tokens
        bucket.otherCalls += 1
      }
    })
  }

  async function day(nowMs = Date.now()) {
    const dayKey = localDayKey(nowMs)
    if (dayCache !== null && dayCache.dayKey === dayKey && nowMs - dayCache.at < DAY_TTL_MS) {
      return dayCache.result
    }
    const rows = await snapshots()
    const result = {
      dayKey,
      costCNY: 0,
      calls: 0,
      tokens: 0,
      otherCalls: 0,
      otherTokens: 0,
      sessions: rows.length,
      scannedSessions: 0,
      failedSessions: 0,
    }
    const seen = new Set()
    for (const row of rows) {
      seen.add(row.id)
      let entry = sessionCache.get(row.id)
      const cacheValid =
        entry !== undefined && entry.revisionKey !== '' && row.revisionKey !== '' && entry.revisionKey === row.revisionKey
      if (!cacheValid) {
        let events
        try {
          events = await readOwnSessionEvents(persistence, row.id)
        } catch {
          result.failedSessions += 1
          continue
        }
        result.scannedSessions += 1
        const buckets = new Map()
        foldIntoBuckets(events, buckets)
        pruneBuckets(buckets, nowMs)
        entry = { revisionKey: row.revisionKey, buckets }
        sessionCache.set(row.id, entry)
      }
      const bucket = entry.buckets.get(dayKey)
      if (bucket !== undefined) {
        result.costCNY += bucket.costCNY
        result.calls += bucket.calls
        result.tokens += bucket.tokens
        result.otherCalls += bucket.otherCalls ?? 0
        result.otherTokens += bucket.otherTokens ?? 0
      }
    }
    for (const id of [...sessionCache.keys()]) if (!seen.has(id)) sessionCache.delete(id)
    dayCache = { at: nowMs, dayKey, result }
    return result
  }

  async function session(sessionId, options = {}) {
    const nowMs = typeof options === 'number' ? options : (options.nowMs ?? Date.now())
    const force = typeof options === 'object' && options !== null && options.force === true
    const cached = detailedCache.get(sessionId)
    if (!force && cached !== undefined && nowMs - cached.at < SESSION_TTL_MS) return cached.result
    const events = await readOwnSessionEvents(persistence, sessionId)
    const result = {
      sessionId,
      costCNY: 0,
      calls: 0,
      tokens: 0,
      otherCalls: 0,
      otherTokens: 0,
      firstAt: null,
      lastAt: null,
    }
    foldUsageEvents(events, (usage) => {
      const tokens = usage.input + usage.output + usage.cache
      if (isDeepSeekRoute(usage.provider, usage.model)) {
        result.costCNY += costOf(usage.time, usage.model, usage.input, usage.cache, usage.output)
        result.tokens += tokens
        result.calls += 1
      } else {
        result.otherTokens += tokens
        result.otherCalls += 1
      }
      if (result.firstAt === null || usage.time < result.firstAt) result.firstAt = usage.time
      if (result.lastAt === null || usage.time > result.lastAt) result.lastAt = usage.time
    })
    detailedCache.set(sessionId, { at: nowMs, result })
    return result
  }

  return { day, session }
}

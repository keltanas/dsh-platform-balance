/**
 * Official Central Bank of Russia (CBR) exchange rates, cached on disk.
 *
 * The widget converts DeepSeek wallet balances and estimated spend into RUB at
 * the official CBR rate (https://www.cbr.ru/scripts/XML_daily.asp). The rate is
 * refreshed every day at 18:00 Moscow time. The cache file keeps the last
 * successful response so a network outage never blanks the widget: the stale
 * rate stays visible and is marked as stale.
 *
 * Cache file: $DSH_HOME/cache/platform-balance/cbr.json (default ~/.dsh/...).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Source of the official rates. */
export const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp'

/** Moscow is UTC+3 all year round (no daylight saving). */
const MSK_OFFSET_MS = 3 * 3_600_000
const DAY_MS = 86_400_000
/** 18:00 Moscow = 15:00 UTC. */
const REFRESH_UTC_HOUR = 15
const FETCH_TIMEOUT_MS = 10_000
const RETRY_DELAY_MS = 15 * 60_000
// After a failed request-path fetch, serve the cached rate without hitting the
// network again for this long, so an outage never turns every 60s poll into a
// timeout wait.
const REQUEST_BACKOFF_MS = 2 * 60_000
const CACHE_VERSION = 1

/** Resolve the plugin cache file, matching the harness home precedence. */
export function resolveCacheFile() {
  const configured = (process.env.DSH_HOME ?? '').trim()
  const home = configured === '' ? path.join(homedir(), '.dsh') : configured
  return path.join(home, 'cache', 'platform-balance', 'cbr.json')
}

/**
 * The most recent 18:00 Moscow instant at or before `nowMs`.
 *
 * @param {number} nowMs - current Unix epoch milliseconds.
 * @returns {number} boundary instant in Unix epoch milliseconds.
 */
export function lastRefreshBoundary(nowMs) {
  const msk = new Date(nowMs + MSK_OFFSET_MS)
  const todayBoundary = Date.UTC(
    msk.getUTCFullYear(),
    msk.getUTCMonth(),
    msk.getUTCDate(),
    REFRESH_UTC_HOUR,
    0,
    0,
  )
  return nowMs >= todayBoundary ? todayBoundary : todayBoundary - DAY_MS
}

/**
 * The next 18:00 Moscow instant strictly after `nowMs`.
 *
 * @param {number} nowMs - current Unix epoch milliseconds.
 * @returns {number} boundary instant in Unix epoch milliseconds.
 */
export function nextRefreshBoundary(nowMs) {
  return lastRefreshBoundary(nowMs) + DAY_MS
}

/**
 * Whether a cached entry already belongs to the current 18:00–18:00 window.
 *
 * @param {{ fetchedAt?: unknown }} entry - cached entry.
 * @param {number} nowMs - current Unix epoch milliseconds.
 * @returns {boolean} true when the entry is fresh.
 */
export function isCacheFresh(entry, nowMs) {
  const fetchedAt = Number(entry?.fetchedAt)
  return Number.isFinite(fetchedAt) && fetchedAt >= lastRefreshBoundary(nowMs)
}

/**
 * Decode the CBR XML body. The response is windows-1251 encoded; only the
 * numeric fields are read, so the Russian names stay untouched.
 *
 * @param {ArrayBuffer | Uint8Array} body - raw response body.
 * @returns {string} decoded XML text.
 */
export function decodeCbrXml(body) {
  return new TextDecoder('windows-1251').decode(body)
}

/**
 * Parse a CBR `XML_daily.asp` document into a RUB rate per currency unit.
 *
 * @param {string} xml - decoded XML document.
 * @returns {{ date: string | null, rates: Record<string, number>, raw: Record<string, { nominal: number, value: number }> }} parsed document.
 */
export function parseCbrXml(xml) {
  const text = String(xml ?? '')
  const dateMatch = /<ValCurs\b[^>]*\bDate="([^"]+)"/.exec(text)
  const rates = {}
  const raw = {}
  for (const block of text.split('<Valute').slice(1)) {
    const charCode = /<CharCode>([A-Z]{3})<\/CharCode>/.exec(block)?.[1]
    const nominalText = /<Nominal>(\d+)<\/Nominal>/.exec(block)?.[1]
    const valueText = /<Value>([\d.,]+)<\/Value>/.exec(block)?.[1]
    if (charCode === undefined || valueText === undefined) continue
    const nominal = nominalText === undefined ? 1 : Number(nominalText)
    const value = Number(valueText.replace(',', '.'))
    if (!Number.isFinite(nominal) || nominal <= 0 || !Number.isFinite(value) || value <= 0) continue
    rates[charCode] = Math.round((value / nominal) * 10000) / 10000
    raw[charCode] = { nominal, value }
  }
  return { date: dateMatch?.[1] ?? null, rates, raw }
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Fetch and parse the current CBR rates.
 *
 * @param {{ fetchImpl?: typeof fetch }} [options] - injectable fetch for tests.
 * @returns {Promise<{ ok: true, data: { date: string | null, rates: Record<string, number>, raw: Record<string, { nominal: number, value: number }> } } | { ok: false, error: string }>} fetch outcome.
 */
export async function fetchCbrRates(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  let response
  try {
    response = await fetchImpl(CBR_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch (err) {
    return { ok: false, error: `Не удалось запросить курс ЦБ: ${errorText(err)}` }
  }
  if (!response.ok) return { ok: false, error: `Курс ЦБ: ответ HTTP ${response.status}` }
  let body
  try {
    body = await response.arrayBuffer()
  } catch (err) {
    return { ok: false, error: `Не удалось прочитать ответ ЦБ: ${errorText(err)}` }
  }
  const parsed = parseCbrXml(decodeCbrXml(body))
  if (!Number.isFinite(parsed.rates.USD) || !Number.isFinite(parsed.rates.CNY)) {
    return { ok: false, error: 'В ответе ЦБ нет курсов USD и CNY' }
  }
  return { ok: true, data: parsed }
}

function validEntry(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    Number.isFinite(Number(entry.fetchedAt)) &&
    entry.rates !== null &&
    typeof entry.rates === 'object' &&
    Number.isFinite(Number(entry.rates.USD)) &&
    Number.isFinite(Number(entry.rates.CNY))
  )
}

/**
 * Create the on-disk CBR rate cache with the 18:00 Moscow refresh schedule.
 *
 * @param {{ file?: string, fetchImpl?: typeof fetch, now?: () => number, log?: (...args: unknown[]) => void }} [options] - injectable dependencies for tests.
 * @returns {{ get: (options?: { force?: boolean }) => Promise<object>, startSchedule: () => () => void, file: string }} cache handle.
 */
export function createCbrCache(options = {}) {
  const file = options.file ?? resolveCacheFile()
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? (() => {})
  let inflight = null
  let timer = null
  let disposed = false
  let lastFailureAt = 0
  let lastFailureError = ''

  async function readCache() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      return validEntry(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  async function writeCache(entry) {
    try {
      await mkdir(path.dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify(entry, null, 2), 'utf8')
      await rename(temporary, file)
    } catch (err) {
      log(`не удалось сохранить кэш курса ЦБ (${file}): ${errorText(err)}`)
    }
  }

  async function refreshOnce() {
    const cached = await readCache()
    const fetched = await fetchCbrRates({ fetchImpl })
    if (fetched.ok) {
      lastFailureAt = 0
      lastFailureError = ''

      const entry = {
        version: CACHE_VERSION,
        fetchedAt: now(),
        source: CBR_URL,
        date: fetched.data.date,
        rates: fetched.data.rates,
        raw: fetched.data.raw,
      }
      await writeCache(entry)
      return { ok: true, data: entry, stale: false }
    }
    log(fetched.error)
    lastFailureAt = now()
    lastFailureError = fetched.error
    if (cached !== null) return { ok: true, data: cached, stale: true, error: fetched.error }
    return fetched
  }

  async function get(getOptions = {}) {
    const force = getOptions.force === true
    const current = now()
    const cached = await readCache()
    if (!force && cached !== null && isCacheFresh(cached, current)) {
      return { ok: true, data: cached, stale: false }
    }
    if (!force && lastFailureAt !== 0 && current - lastFailureAt < REQUEST_BACKOFF_MS) {
      if (cached !== null) return { ok: true, data: cached, stale: true, error: lastFailureError }
      return { ok: false, error: lastFailureError }
    }
    if (inflight !== null) return inflight
    inflight = refreshOnce()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  function schedule(delayMs) {
    timer = setTimeout(() => {
      timer = null
      void runScheduled()
    }, Math.max(0, delayMs))
    // Never keep the host process alive just for the refresh timer.
    timer.unref?.()
  }

  async function runScheduled() {
    if (disposed) return
    const result = await get({ force: true })
    if (disposed) return
    const current = now()
    const nextBoundary = nextRefreshBoundary(current)
    // A stale fallback means the refresh failed: retry sooner instead of
    // waiting a whole day.
    const refreshed = result.ok === true && result.stale !== true
    const delay = refreshed
      ? Math.max(1_000, nextBoundary - current + 1_000)
      : Math.min(RETRY_DELAY_MS, Math.max(1_000, nextBoundary - current))
    schedule(delay)
  }

  return {
    file,
    get,
    /** Install the refresh timer; the returned disposer clears it. */
    startSchedule() {
      const current = now()
      schedule(Math.max(1_000, nextRefreshBoundary(current) - current + 1_000))
      return () => {
        disposed = true
        if (timer !== null) clearTimeout(timer)
        timer = null
      }
    },
  }
}

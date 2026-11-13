/**
 * dsh-platform-balance — host half.
 *
 * Serves the small JSON API the browser widget reads:
 *
 *   GET /api/platform-balance/overview        wallets + CBR rates + today's spend
 *   GET /api/platform-balance/session?id=...  one session's estimated spend
 *
 * Balances come from the harness account service (browser login) with a
 * DEEPSEEK_API_KEY fallback. CBR rates are cached on disk and refreshed at
 * 18:00 Moscow time. Spend is estimated from session logs and the official
 * DeepSeek CNY price schedule. The empty `apply` of a pure UI plugin is not
 * enough here, so this half lives in Node and the browser half rides `./client`.
 */

import { createCbrCache, nextRefreshBoundary } from './cbr.js'
import { isTrustedApiRequest, writeJson } from './http.js'
import { PRICING_CURRENCY, pricingInfo } from './pricing.js'
import { createUsageScanner } from './usage.js'
import { readBalance } from './wallet.js'

/** Loader row id from `cordis.patch.yml`. */
export const name = 'platform-balance'

/** Host services the routes depend on; `deepseekAccount` is optional and read through `ctx.get`. */
export const inject = ['webServer', 'credentials', 'sessionPersistence']

const BALANCE_TTL_MS = 60_000
const DAY_TTL_MS = 120_000
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function errorText(err) {
  return err instanceof Error ? err.message : String(err)
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/** TTL memo with in-flight deduplication; failed results are never cached. */
function memoize(ttlMs, compute) {
  const state = { entry: undefined, inflight: undefined }
  const run = () => {
    if (state.inflight !== undefined) return state.inflight
    const task = Promise.resolve()
      .then(compute)
      .then(
        (value) => {
          state.inflight = undefined
          if (value.ok === true) state.entry = { value, setAt: Date.now() }
          return value
        },
        (err) => {
          state.inflight = undefined
          throw err
        },
      )
    state.inflight = task
    return task
  }
  return {
    get: () => {
      const hit = state.entry
      if (hit !== undefined && hit.value.ok === true && Date.now() - hit.setAt < ttlMs) {
        return Promise.resolve(hit.value)
      }
      return run()
    },
    refresh: () => run(),
  }
}

function rateOf(rates, currency) {
  if (rates === null || rates === undefined) return null
  const rate = Number(rates[currency])
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

/** Attach a RUB value to every wallet and the overall total. */
function decorateWallets(wallets, rates) {
  return wallets.map((wallet) => {
    const rate = rateOf(rates, wallet.currency)
    const total = Number(wallet.total)
    return {
      ...wallet,
      rate,
      rub: rate === null || !Number.isFinite(total) ? null : round2(total * rate),
    }
  })
}

function overviewPayload({ balance, rates, day }) {
  const rateTable = rates.ok === true ? rates.data.rates : null
  const wallets = balance.ok === true ? decorateWallets(balance.wallets, rateTable) : []
  const totalRub = wallets.reduce((sum, wallet) => sum + (wallet.rub ?? 0), 0)
  const dayCost = day.ok === true ? Number(day.data.costCNY) : null
  const cnyRate = rateOf(rateTable, 'CNY')
  // The CBR document lists every currency; the widget only needs the wallet
  // currencies plus CNY (for the spend conversion).
  const visibleCodes = new Set(['USD', 'CNY', ...wallets.map((wallet) => wallet.currency)])
  const visibleRates = {}
  for (const code of visibleCodes) {
    const rate = rateOf(rateTable, code)
    if (rate !== null) visibleRates[code] = rate
  }
  return {
    ok: true,
    data: {
      generatedAt: Date.now(),
      balance:
        balance.ok === true
          ? {
              source: balance.source,
              isAvailable: balance.isAvailable === true,
              wallets,
              totalRub,
            }
          : { error: balance.error },
      cbr:
        rates.ok === true
          ? {
              date: rates.data.date,
              fetchedAt: rates.data.fetchedAt,
              stale: rates.stale === true,
              rates: visibleRates,
              error: rates.error ?? null,
            }
          : { error: rates.error },
      spend:
        day.ok === true
          ? {
              currency: PRICING_CURRENCY,
              estimated: true,
              pricing: pricingInfo(),
              day: {
                ...day.data,
                rub: cnyRate === null ? null : round2(dayCost * cnyRate),
              },
            }
          : { error: day.error },
    },
  }
}

/**
 * Install the plugin's HTTP routes, the CBR refresh timer, and a first-run
 * cache warm-up.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 */
export function apply(ctx) {
  const log = (...args) => {
    try {
      console.warn('[dsh-platform-balance]', ...args)
    } catch {
      // Logging must never break a request.
    }
  }

  const cbr = createCbrCache({ log })
  const balanceMemo = memoize(BALANCE_TTL_MS, () => readBalance(ctx))
  const usage = createUsageScanner(ctx.sessionPersistence)
  const dayMemo = memoize(DAY_TTL_MS, async () => {
    try {
      return { ok: true, data: await usage.day() }
    } catch (err) {
      return { ok: false, error: `Не удалось прочитать журналы сессий: ${errorText(err)}` }
    }
  })

  async function sessionPayload(sessionId, force) {
    const [sessionResult, ratesResult] = await Promise.allSettled([
      usage.session(sessionId, { force }),
      cbr.get(),
    ])
    if (sessionResult.status === 'rejected') {
      return { ok: false, error: `Не удалось прочитать журнал сессии: ${errorText(sessionResult.reason)}` }
    }
    const rates = ratesResult.status === 'fulfilled' && ratesResult.value.ok === true ? ratesResult.value.data.rates : null
    const cnyRate = rateOf(rates, 'CNY')
    const data = sessionResult.value
    return {
      ok: true,
      data: {
        sessionId,
        currency: PRICING_CURRENCY,
        estimated: true,
        costCNY: data.costCNY,
        rub: cnyRate === null ? null : round2(data.costCNY * cnyRate),
        calls: data.calls,
        tokens: data.tokens,
        otherCalls: data.otherCalls ?? 0,
        otherTokens: data.otherTokens ?? 0,
        lastAt: data.lastAt,
      },
    }
  }

  async function overview(force) {
    const [balanceResult, ratesResult, dayResult] = await Promise.allSettled([
      force ? balanceMemo.refresh() : balanceMemo.get(),
      cbr.get({ force }),
      force ? dayMemo.refresh() : dayMemo.get(),
    ])
    const balance =
      balanceResult.status === 'fulfilled'
        ? balanceResult.value
        : { ok: false, error: `Не удалось получить баланс: ${errorText(balanceResult.reason)}` }
    const rates =
      ratesResult.status === 'fulfilled'
        ? ratesResult.value
        : { ok: false, error: `Не удалось получить курс ЦБ: ${errorText(ratesResult.reason)}` }
    const day =
      dayResult.status === 'fulfilled'
        ? dayResult.value
        : { ok: false, error: `Не удалось посчитать расход: ${errorText(dayResult.reason)}` }
    return overviewPayload({ balance, rates, day })
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/api/platform-balance',
        handler: async (req, res) => {
          try {
            if (!isTrustedApiRequest(req)) {
              writeJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            if (req.method !== 'GET') {
              writeJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const url = new URL(req.url ?? '/', 'http://dsh.internal')
            const pathname = url.pathname
            const force = url.searchParams.get('refresh') === '1'
            if (pathname === '/api/platform-balance/overview') {
              writeJson(res, 200, await overview(force), { 'cache-control': 'no-store' })
              return
            }
            if (pathname === '/api/platform-balance/session') {
              const id = url.searchParams.get('id')
              if (id === null || id.trim() === '' || !SESSION_ID_PATTERN.test(id)) {
                writeJson(res, 400, { ok: false, error: 'Некорректный id сессии' }, { 'cache-control': 'no-store' })
                return
              }
              writeJson(res, 200, await sessionPayload(id, force), { 'cache-control': 'no-store' })
              return
            }
            writeJson(res, 404, { ok: false, error: 'not found' }, { 'cache-control': 'no-store' })
          } catch (err) {
            log(`ошибка обработки запроса: ${errorText(err)}`)
            if (!res.headersSent) writeJson(res, 500, { ok: false, error: 'internal error' })
            else res.end()
          }
        },
      }),
    'dsh-platform-balance: /api/platform-balance routes',
  )

  ctx.effect(() => cbr.startSchedule(), 'dsh-platform-balance: CBR 18:00 MSK refresh')

  // Warm both caches once after boot so the first widget request is fast: the
  // CBR file lands on disk and the day aggregate is scanned before the browser
  // asks. Deferred so plugin activation never blocks on network or disk.
  ctx.effect(() => {
    const cbrTimer = setTimeout(() => {
      void cbr.get().catch(() => {})
    }, 1_500)
    cbrTimer.unref?.()
    const dayTimer = setTimeout(() => {
      void dayMemo.get().catch(() => {})
    }, 3_000)
    dayTimer.unref?.()
    return () => {
      clearTimeout(cbrTimer)
      clearTimeout(dayTimer)
    }
  }, 'dsh-platform-balance: cache warm-up')

  log(
    `маршруты готовы, курс ЦБ обновится в ${new Date(nextRefreshBoundary(Date.now())).toISOString()} (18:00 МСК)`,
  )
}

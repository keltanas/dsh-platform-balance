/**
 * CNY cost estimation for DeepSeek usage records.
 *
 * The platform bills in CNY (international accounts in USD), and the session log
 * carries token counts but no money. `costOf` turns one recorded request into an
 * estimated CNY amount using the official DeepSeek price schedule:
 *
 *   - flat prices before 2026-08-17 00:00 Beijing;
 *   - peak/off-peak pricing from that instant (peak costs twice the off-peak price);
 *   - the 2026-09-10 12:00 Beijing Flash price cut, after which peak hours apply
 *     on weekdays only;
 *   - from 2026-09-14 12:00 Beijing pro requests are served by V4.1-Flash and
 *     billed at Flash prices.
 *
 * Prices are CNY per one million tokens. Only routes served by the DeepSeek
 * platform are priced here (see `isDeepSeekRoute`): requests through other
 * providers never spend the platform balance, so they are not billed at all.
 * When DeepSeek changes its price list, this table is the only file to update.
 */

/** Currency the estimate is expressed in. */
export const PRICING_CURRENCY = 'CNY'

// 2026-08-17 00:00 Beijing (UTC+8) = 2026-08-16 16:00 UTC.
const PEAK_PRICING_FROM_MS = Date.UTC(2026, 7, 16, 16, 0, 0)
// 2026-09-10 12:00 Beijing = 2026-09-10 04:00 UTC.
const V41_FLASH_PRICING_FROM_MS = Date.UTC(2026, 8, 10, 4, 0, 0)
// 2026-09-14 12:00 Beijing = 2026-09-14 04:00 UTC.
const PRO_ROUTED_TO_FLASH_FROM_MS = Date.UTC(2026, 8, 14, 4, 0, 0)

const BEIJING_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000
const PEAK_WINDOWS = /** @type {const} */ ([[9, 12], [14, 18]])

const FLAT_RATES = {
  pro: { cacheHit: 0.025, input: 3, output: 6 },
  flash: { cacheHit: 0.02, input: 1, output: 2 },
  // The vision model billed at Flash rates from day one.
  vision: { cacheHit: 0.02, input: 1, output: 2 },
}

const PEAK_RATES_08_17 = {
  pro: { cacheHit: 0.3, input: 9, output: 27 },
  flash: { cacheHit: 0.1, input: 3, output: 9 },
  vision: { cacheHit: 0.1, input: 3, output: 9 },
}

const PEAK_RATES_09_10 = {
  pro: { cacheHit: 0.3, input: 9, output: 27 },
  flash: { cacheHit: 0.04, input: 2, output: 8 },
  vision: { cacheHit: 0.04, input: 2, output: 8 },
}

const PRICE_ERAS = [
  { fromMs: PEAK_PRICING_FROM_MS, peak: PEAK_RATES_08_17, weekdaysOnly: false },
  { fromMs: V41_FLASH_PRICING_FROM_MS, peak: PEAK_RATES_09_10, weekdaysOnly: true },
]

function eraAt(timeMs) {
  let era = PRICE_ERAS[0]
  for (const candidate of PRICE_ERAS) if (timeMs >= candidate.fromMs) era = candidate
  return era
}

function halved(rates) {
  return { cacheHit: rates.cacheHit / 2, input: rates.input / 2, output: rates.output / 2 }
}

/** Platform model ids look like `deepseek`, `deepseek-flash`, `deepseek-v4-pro`. */
const DEEPSEEK_MODEL = /^deepseek([-./]|$)/

/**
 * Whether a request route is billed to the DeepSeek platform balance.
 *
 * A session log records the provider id and model of every request. The DeepSeek
 * price schedule only applies to requests served by the DeepSeek platform —
 * the provider id names it (`deepseek-official`, `deepseek-account`). Other
 * providers must never be priced by this schedule, even when they serve a model
 * whose id looks like a DeepSeek model (for example, `opencode-go` serving
 * `deepseek-v4.1-flash` for free, or a local `ollama` running `deepseek-r1`).
 * When a legacy log has no provider, fall back to the model id; a route with
 * neither provider nor model cannot be attributed to the platform and is not
 * billed.
 *
 * @param {string} provider - provider id from the request header, may be empty.
 * @param {string} model - model id from the request header, may be empty.
 * @returns {boolean} true when the DeepSeek price schedule applies.
 */
export function isDeepSeekRoute(provider, model) {
  const providerId = String(provider ?? '').toLowerCase().trim()
  if (providerId !== '') return providerId.includes('deepseek')
  return DEEPSEEK_MODEL.test(String(model ?? '').toLowerCase().trim())
}

/** Classify a model id into the billed price tier. */
export function tierOf(model) {
  const name = String(model ?? '').toLowerCase()
  if (name.includes('vision')) return 'vision'
  if (name.includes('flash')) return 'flash'
  return 'pro'
}

function billedTierOf(timeMs, model) {
  const tier = tierOf(model)
  return tier === 'pro' && timeMs >= PRO_ROUTED_TO_FLASH_FROM_MS ? 'flash' : tier
}

function isBeijingWeekday(timeMs) {
  const day = new Date(timeMs + BEIJING_OFFSET_MS).getUTCDay()
  return day >= 1 && day <= 5
}

/** Whether one instant falls inside a Beijing peak window for its price era. */
export function isPeak(timeMs) {
  if (eraAt(timeMs).weekdaysOnly && !isBeijingWeekday(timeMs)) return false
  const hour = Math.floor((((timeMs + BEIJING_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / 3_600_000)
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

/** Effective CNY rates per one million tokens for one instant and model. */
export function ratesAt(timeMs, model) {
  if (timeMs < PEAK_PRICING_FROM_MS) return FLAT_RATES[tierOf(model)]
  const peak = eraAt(timeMs).peak[billedTierOf(timeMs, model)]
  return isPeak(timeMs) ? peak : halved(peak)
}

/**
 * Estimate the CNY cost of one recorded request.
 *
 * @param {number} timeMs - request completion time in Unix epoch milliseconds.
 * @param {string} model - model id from the request header.
 * @param {number} inputTokens - uncached input tokens.
 * @param {number} cacheReadTokens - cache-hit input tokens.
 * @param {number} outputTokens - output tokens.
 * @returns {number} estimated CNY amount.
 */
export function costOf(timeMs, model, inputTokens, cacheReadTokens, outputTokens) {
  const rates = ratesAt(timeMs, model)
  return (inputTokens * rates.input + cacheReadTokens * rates.cacheHit + outputTokens * rates.output) / 1_000_000
}

/** Human-readable price table used by the widget's "estimate" tooltip. */
export function pricingInfo(nowMs = Date.now()) {
  const era = eraAt(nowMs)
  const row = (model, tier) => ({ model, peak: era.peak[tier], offPeak: halved(era.peak[tier]) })
  return {
    currency: PRICING_CURRENCY,
    inPeakNow: isPeak(nowMs),
    peakWindows: ['09:00–12:00', '14:00–18:00'],
    tiers: [row('deepseek-flash', 'flash'), row('deepseek-v4-pro', 'pro')],
  }
}

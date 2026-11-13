import assert from 'node:assert/strict'
import test from 'node:test'

import { costOf, isDeepSeekRoute, isPeak, pricingInfo, ratesAt, tierOf } from '../lib/pricing.js'

function beijing(iso) {
  // ISO strings with an explicit +08:00 offset already encode the UTC instant.
  return Date.parse(iso)
}

test('tierOf classifies the shipped model ids', () => {
  assert.equal(tierOf('deepseek-flash'), 'flash')
  assert.equal(tierOf('deepseek-v4-flash-vision-exp'), 'vision')
  assert.equal(tierOf('deepseek-v4-pro'), 'pro')
  assert.equal(tierOf('unknown-model'), 'pro')
})

test('flat prices apply before the 2026-08-17 switch', () => {
  const time = Date.UTC(2026, 6, 1, 0, 0, 0)
  assert.deepEqual(ratesAt(time, 'deepseek-flash'), { cacheHit: 0.02, input: 1, output: 2 })
  assert.equal(costOf(time, 'deepseek-flash', 1_000_000, 0, 0), 1)
  assert.equal(costOf(time, 'deepseek-flash', 0, 1_000_000, 0), 0.02)
  assert.equal(costOf(time, 'deepseek-flash', 0, 0, 1_000_000), 2)
})

test('peak pricing doubles flash rates on weekday peak windows', () => {
  // Wednesday 2026-11-11 10:00 Beijing.
  const weekdayPeak = beijing('2026-11-11T10:00:00+08:00')
  assert.equal(isPeak(weekdayPeak), true)
  assert.deepEqual(ratesAt(weekdayPeak, 'deepseek-flash'), { cacheHit: 0.04, input: 2, output: 8 })
  // Same weekday at 20:00 Beijing is off-peak.
  const weekdayOffPeak = beijing('2026-11-11T20:00:00+08:00')
  assert.equal(isPeak(weekdayOffPeak), false)
  assert.deepEqual(ratesAt(weekdayOffPeak, 'deepseek-flash'), { cacheHit: 0.02, input: 1, output: 4 })
})

test('peak hours apply on weekdays only after the 2026-09-10 cut', () => {
  // Saturday 2026-11-14 10:00 Beijing.
  const saturdayPeak = beijing('2026-11-14T10:00:00+08:00')
  assert.equal(isPeak(saturdayPeak), false)
  assert.equal(ratesAt(saturdayPeak, 'deepseek-flash').input, 1)
  // Before the cut weekends were still peak-priced.
  const saturdayEarly = beijing('2026-08-22T10:00:00+08:00')
  assert.equal(isPeak(saturdayEarly), true)
})

test('pro requests are billed at flash rates after the 2026-09-14 reroute', () => {
  const before = beijing('2026-09-14T11:00:00+08:00')
  const after = beijing('2026-09-14T15:00:00+08:00')
  assert.equal(ratesAt(before, 'deepseek-v4-pro').input, 9)
  assert.equal(ratesAt(after, 'deepseek-v4-pro').input, 2)
})

test('costOf combines cached, uncached, and output tokens', () => {
  const time = beijing('2026-11-11T10:00:00+08:00')
  const cost = costOf(time, 'deepseek-flash', 1_000_000, 2_000_000, 500_000)
  assert.equal(cost, 2 + 0.08 + 4)
})

test('pricingInfo exposes the current era tier table', () => {
  const info = pricingInfo(beijing('2026-11-11T10:00:00+08:00'))
  assert.equal(info.currency, 'CNY')
  assert.equal(info.inPeakNow, true)
  assert.equal(info.tiers.length, 2)
  assert.equal(info.tiers[0].peak.input, 2)
})

test('isDeepSeekRoute gates the price schedule by the platform provider', () => {
  assert.equal(isDeepSeekRoute('deepseek-account', 'deepseek-flash'), true)
  assert.equal(isDeepSeekRoute('deepseek-official', 'deepseek-v4-pro'), true)
  assert.equal(isDeepSeekRoute('DeepSeek', 'deepseek-chat'), true)
  // Other providers must never be priced by the DeepSeek schedule, even when
  // the model id looks like a platform model (free gateways, local ollama).
  assert.equal(isDeepSeekRoute('opencode-go', 'deepseek-v4.1-flash'), false)
  assert.equal(isDeepSeekRoute('ollama', 'deepseek-r1:latest'), false)
  assert.equal(isDeepSeekRoute('strata', 'qwen3.8-flash-next'), false)
  // Legacy logs without a recorded provider fall back to the model id.
  assert.equal(isDeepSeekRoute('', 'deepseek-chat'), true)
  assert.equal(isDeepSeekRoute(undefined, 'deepseek-v4-pro'), true)
  assert.equal(isDeepSeekRoute('', 'qwen2.5-coder:3b-instruct'), false)
  assert.equal(isDeepSeekRoute(undefined, undefined), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { costOf } from '../lib/pricing.js'
import { createUsageScanner, foldUsageEvents, localDayKey } from '../lib/usage.js'

function usageEvent(time, usage) {
  return { type: 'assistant/message', time, data: { usage } }
}

function routeEvent(provider, model) {
  return { type: 'request/header', data: { header: { config: { provider, model } } } }
}

function compactionEvent(time, data) {
  return { type: 'compaction/summary', time, data }
}

function withSeq(events) {
  return events.map((event, seq) => ({ ...event, seq }))
}

/** Build a persistence double over a mutable map of session id -> { revision, events }. */
function createPersistence(initial) {
  const sessions = new Map(Object.entries(initial))
  const opened = []
  return {
    sessions,
    opened,
    listCalls: 0,
    async list() {
      this.listCalls += 1
      return [...sessions].map(([id, session]) => ({
        header: { id },
        revision: session.revision,
        sizeBytes: 1,
      }))
    },
    async open(id, mode) {
      opened.push({ id, mode })
      const session = sessions.get(id)
      assert.ok(session, `unexpected session ${id}`)
      return {
        inheritedEventCount: session.inherited ?? 0,
        async read(offset = 0) {
          const events = session.events.slice(offset)
          return { events }
        },
        async close() {},
      }
    },
  }
}

test('localDayKey uses the local calendar day', () => {
  const time = new Date(2026, 10, 12, 23, 30, 0).getTime()
  assert.equal(localDayKey(time), '2026-11-12')
})

test('foldUsageEvents pairs usage with the latest request route', () => {
  const events = [
    routeEvent('deepseek-account', 'deepseek-flash'),
    usageEvent(1000, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 }),
    routeEvent('pi-ai', 'deepseek-v4-pro'),
    usageEvent(2000, { inputTokens: 1, outputTokens: 1 }),
    { type: 'assistant/message', time: 3000, data: {} },
    { type: 'assistant/message', time: 'nope', data: { usage: { inputTokens: 1 } } },
  ]
  const seen = []
  const count = foldUsageEvents(events, (usage) => seen.push(usage))
  assert.equal(count, 2)
  assert.deepEqual(seen[0], { time: 1000, provider: 'deepseek-account', model: 'deepseek-flash', input: 10, output: 2, cache: 3 })
  assert.equal(seen[1].model, 'deepseek-v4-pro')
  assert.equal(seen[1].cache, 0)
})

test('createUsageScanner sums the current day and reuses unchanged sessions', async () => {
  const today = new Date(2026, 10, 12, 12, 0, 0).getTime()
  const yesterday = new Date(2026, 10, 11, 12, 0, 0).getTime()
  const persistence = createPersistence({
    s1: {
      revision: 'r1',
      events: [
        routeEvent('deepseek-account', 'deepseek-flash'),
        usageEvent(today - 2 * 3_600_000, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
        usageEvent(today - 3_600_000, { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 }),
        usageEvent(yesterday, { inputTokens: 5_000_000, outputTokens: 0, cacheReadTokens: 0 }),
      ],
    },
    s2: {
      revision: 'r1',
      events: [routeEvent('deepseek-account', 'deepseek-flash'), usageEvent(yesterday, { inputTokens: 9, outputTokens: 9, cacheReadTokens: 9 })],
    },
    s3: {
      revision: 'r1',
      events: [routeEvent('deepseek-account', 'deepseek-flash'), usageEvent(today - 60_000, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })],
    },
  })
  const scanner = createUsageScanner(persistence)

  const expectedToday =
    costOf(today - 2 * 3_600_000, 'deepseek-flash', 1_000_000, 0, 0) +
    costOf(today - 3_600_000, 'deepseek-flash', 0, 0, 1_000_000) +
    costOf(today - 60_000, 'deepseek-flash', 0, 0, 0)

  const first = await scanner.day(today)
  assert.equal(first.dayKey, '2026-11-12')
  assert.equal(first.sessions, 3)
  assert.equal(first.scannedSessions, 3)
  assert.equal(first.calls, 3)
  assert.ok(Math.abs(first.costCNY - expectedToday) < 1e-9)
  assert.equal(persistence.opened.length, 3)

  // Second call inside the TTL returns the memoized aggregate.
  const second = await scanner.day(today + 1_000)
  assert.equal(second, first)
  assert.equal(persistence.opened.length, 3)

  // After the TTL a changed session is the only one re-read.
  persistence.sessions.get('s1').revision = 'r2'
  persistence.sessions.get('s1').events.push(
    usageEvent(today - 30_000, { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 }),
  )
  const third = await scanner.day(today + 130_000)
  assert.equal(persistence.opened.length, 4)
  assert.ok(third.costCNY > second.costCNY)
  assert.equal(third.failedSessions, 0)
})

test('createUsageScanner never trusts a backend without revisions', async () => {
  const today = new Date(2026, 10, 12, 12, 0, 0).getTime()
  const persistence = createPersistence({
    s1: { revision: undefined, events: [routeEvent('p', 'deepseek-flash'), usageEvent(today, { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 })] },
  })
  const scanner = createUsageScanner(persistence)
  await scanner.day(today)
  await scanner.day(today + 130_000)
  assert.equal(persistence.opened.length, 2)
})

test('createUsageScanner returns one session lifetime total', async () => {
  const today = new Date(2026, 10, 12, 12, 0, 0).getTime()
  const persistence = createPersistence({
    s1: {
      revision: 'r1',
      events: [
        routeEvent('p', 'deepseek-flash'),
        usageEvent(today - 3_600_000, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
        usageEvent(today, { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 }),
      ],
    },
  })
  const scanner = createUsageScanner(persistence)
  const result = await scanner.session('s1', today)
  assert.equal(result.sessionId, 's1')
  assert.equal(result.calls, 2)
  assert.equal(result.tokens, 2_000_000)
  assert.equal(result.firstAt, today - 3_600_000)
  assert.equal(result.lastAt, today)
  // Peak weekday flash rates: 1M input * 2 + 1M output * 8 = 10 CNY.
  assert.ok(Math.abs(result.costCNY - 10) < 1e-9)
  await scanner.session('s1', today + 1_000)
  assert.equal(persistence.opened.length, 1)
})

test('createUsageScanner survives unreadable sessions', async () => {
  const today = new Date(2026, 10, 12, 12, 0, 0).getTime()
  const persistence = {
    async list() {
      return [{ header: { id: 'broken' }, revision: 'r1' }]
    },
    async open() {
      throw new Error('unreadable')
    },
  }
  const scanner = createUsageScanner(persistence)
  const result = await scanner.day(today)
  assert.equal(result.failedSessions, 1)
  assert.equal(result.costCNY, 0)
})


test('seeded sessions do not double-count their inherited prefix', async () => {
  const today = new Date(2026, 10, 12, 12, 0, 0).getTime()
  const yesterday = new Date(2026, 10, 11, 12, 0, 0).getTime()
  const persistence = createPersistence({
    parent: {
      revision: 'r1',
      events: withSeq([
        routeEvent('p', 'deepseek-flash'),
        usageEvent(today - 3_600_000, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
      ]),
    },
    fork: {
      revision: 'r1',
      inherited: 2,
      events: withSeq([
        // Byte-identical inherited prefix copied from the parent log.
        routeEvent('p', 'deepseek-flash'),
        usageEvent(today - 3_600_000, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
        // Own work of the forked session.
        routeEvent('p', 'deepseek-flash'),
        usageEvent(today, { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 }),
      ]),
    },
  })
  const scanner = createUsageScanner(persistence)
  const result = await scanner.day(today)
  const ownCost =
    costOf(today - 3_600_000, 'deepseek-flash', 1_000_000, 0, 0) +
    costOf(today, 'deepseek-flash', 0, 0, 1_000_000)
  assert.ok(Math.abs(result.costCNY - ownCost) < 1e-9, `expected ${ownCost}, got ${result.costCNY}`)
  assert.equal(result.calls, 2)

  const fork = await scanner.session('fork', today)
  assert.equal(fork.calls, 1, 'a forked session spends only its own requests')
  assert.ok(Math.abs(fork.costCNY - costOf(today, 'deepseek-flash', 0, 0, 1_000_000)) < 1e-9)

  // A different day re-aggregates cached buckets without touching the logs.
  const opened = persistence.opened.length
  const yesterdayResult = await scanner.day(yesterday)
  assert.equal(yesterdayResult.costCNY, 0)
  assert.equal(persistence.opened.length, opened)
})

test('compaction summary calls are priced with their own route', async () => {
  const today = new Date(2026, 10, 12, 12, 0, 0).getTime()
  const persistence = createPersistence({
    s1: {
      revision: 'r1',
      events: withSeq([
        routeEvent('deepseek-account', 'deepseek-flash'),
        compactionEvent(today, {
          provider: 'deepseek-account',
          model: 'deepseek-v4-pro',
          usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
        }),
      ]),
    },
  })
  const scanner = createUsageScanner(persistence)
  const result = await scanner.session('s1', today)
  assert.equal(result.calls, 1)
  // Peak weekday pro is rerouted to Flash pricing from 2026-09-14: 1M input * 2.
  assert.ok(Math.abs(result.costCNY - 2) < 1e-9, `got ${result.costCNY}`)
})

test('a midnight rollover re-aggregates buckets without re-reading logs', async () => {
  const today = new Date(2026, 10, 12, 12, 0, 0).getTime()
  const tomorrow = new Date(2026, 10, 13, 12, 0, 0).getTime()
  const persistence = createPersistence({
    s1: {
      revision: 'r1',
      events: withSeq([
        routeEvent('p', 'deepseek-flash'),
        usageEvent(today, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }),
      ]),
    },
  })
  const scanner = createUsageScanner(persistence)
  const first = await scanner.day(today)
  assert.ok(first.costCNY > 0)
  assert.equal(persistence.opened.length, 1)
  const next = await scanner.day(tomorrow)
  assert.equal(next.dayKey, '2026-11-13')
  assert.equal(next.costCNY, 0)
  assert.equal(persistence.opened.length, 1, 'unchanged sessions must not be re-read at midnight')
})

test('session(force) bypasses the per-session TTL', async () => {
  const today = new Date(2026, 10, 12, 12, 0, 0).getTime()
  const persistence = createPersistence({
    s1: {
      revision: 'r1',
      events: withSeq([routeEvent('p', 'deepseek-flash'), usageEvent(today, { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 })]),
    },
  })
  const scanner = createUsageScanner(persistence)
  await scanner.session('s1', { nowMs: today })
  await scanner.session('s1', { nowMs: today + 1_000 })
  assert.equal(persistence.opened.length, 1)
  await scanner.session('s1', { nowMs: today + 1_000, force: true })
  assert.equal(persistence.opened.length, 2)
})

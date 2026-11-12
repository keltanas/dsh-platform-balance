import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createCbrCache,
  decodeCbrXml,
  fetchCbrRates,
  isCacheFresh,
  lastRefreshBoundary,
  nextRefreshBoundary,
  parseCbrXml,
} from '../lib/cbr.js'

const SAMPLE_XML = `<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="13.11.2026" name="Foreign Currency Market"><Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>Доллар США</Name><Value>82,9803</Value></Valute><Valute ID="R01375"><NumCode>156</NumCode><CharCode>CNY</CharCode><Nominal>1</Nominal><Name>Китайский юань</Name><Value>12,4009</Value></Valute><Valute ID="R01375J"><NumCode>392</NumCode><CharCode>JPY</CharCode><Nominal>100</Nominal><Name>Иена</Name><Value>60,0000</Value></Valute></ValCurs>`

test('parseCbrXml reads the quote date and per-unit rates', () => {
  const parsed = parseCbrXml(SAMPLE_XML)
  assert.equal(parsed.date, '13.11.2026')
  assert.equal(parsed.rates.USD, 82.9803)
  assert.equal(parsed.rates.CNY, 12.4009)
  // Nominal 100 must be divided out.
  assert.equal(parsed.rates.JPY, 0.6)
  assert.deepEqual(parsed.raw.CNY, { nominal: 1, value: 12.4009 })
})

test('parseCbrXml tolerates an empty or broken document', () => {
  assert.deepEqual(parseCbrXml(''), { date: null, rates: {}, raw: {} })
  assert.deepEqual(parseCbrXml('<ValCurs><Valute><CharCode>USD</CharCode></Valute></ValCurs>'), {
    date: null,
    rates: {},
    raw: {},
  })
})

test('decodeCbrXml decodes windows-1251 bodies', () => {
  const buffer = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])
  assert.equal(decodeCbrXml(buffer), 'Привет')
})

test('refresh boundary is 18:00 Moscow (15:00 UTC)', () => {
  // 2026-11-12 19:00 MSK = 16:00 UTC.
  const evening = Date.UTC(2026, 10, 12, 16, 0, 0)
  assert.equal(lastRefreshBoundary(evening), Date.UTC(2026, 10, 12, 15, 0, 0))
  assert.equal(nextRefreshBoundary(evening), Date.UTC(2026, 10, 13, 15, 0, 0))
  // 2026-11-12 17:00 MSK = 14:00 UTC: today's boundary has not happened yet.
  const afternoon = Date.UTC(2026, 10, 12, 14, 0, 0)
  assert.equal(lastRefreshBoundary(afternoon), Date.UTC(2026, 10, 11, 15, 0, 0))
  assert.equal(nextRefreshBoundary(afternoon), Date.UTC(2026, 10, 12, 15, 0, 0))
  // Exactly at the boundary the new window is already current.
  const exact = Date.UTC(2026, 10, 12, 15, 0, 0)
  assert.equal(lastRefreshBoundary(exact), exact)
})

test('isCacheFresh only accepts entries from the current 18:00 window', () => {
  const now = Date.UTC(2026, 10, 12, 16, 0, 0) // 19:00 MSK
  assert.equal(isCacheFresh({ fetchedAt: Date.UTC(2026, 10, 12, 15, 30, 0) }, now), true)
  assert.equal(isCacheFresh({ fetchedAt: Date.UTC(2026, 10, 12, 14, 30, 0) }, now), false)
  assert.equal(isCacheFresh({}, now), false)
})

function xmlResponse(xml) {
  const body = Buffer.from(xml, 'utf8')
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    },
  }
}

function temporaryClock(startMs) {
  let current = startMs
  return {
    now: () => current,
    set(value) {
      current = value
    },
  }
}

test('fetchCbrRates reports transport and shape failures', async () => {
  const network = await fetchCbrRates({
    fetchImpl: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(network.ok, false)
  assert.match(network.error, /Не удалось запросить курс ЦБ/)

  const rejected = await fetchCbrRates({ fetchImpl: async () => ({ ok: false, status: 503 }) })
  assert.equal(rejected.ok, false)
  assert.match(rejected.error, /503/)

  const incomplete = await fetchCbrRates({
    fetchImpl: async () => xmlResponse('<ValCurs Date="13.11.2026"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>82,9803</Value></Valute></ValCurs>'),
  })
  assert.equal(incomplete.ok, false)
  assert.match(incomplete.error, /USD и CNY/)
})

test('createCbrCache fetches once, persists the file, and refetches after 18:00 MSK', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dpb-cbr-'))
  const file = path.join(directory, 'cbr.json')
  const clock = temporaryClock(Date.UTC(2026, 10, 12, 16, 0, 0))
  let fetches = 0
  const cache = createCbrCache({
    file,
    now: clock.now,
    fetchImpl: async () => {
      fetches += 1
      return xmlResponse(SAMPLE_XML)
    },
  })
  try {
    const first = await cache.get()
    assert.equal(first.ok, true)
    assert.equal(first.stale, false)
    assert.equal(first.data.rates.CNY, 12.4009)
    assert.equal(fetches, 1)

    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(onDisk.date, '13.11.2026')
    assert.equal(onDisk.rates.USD, 82.9803)

    const second = await cache.get()
    assert.equal(second.ok, true)
    assert.equal(fetches, 1, 'a fresh cache must serve without another request')

    clock.set(Date.UTC(2026, 10, 13, 16, 0, 0))
    const third = await cache.get()
    assert.equal(third.ok, true)
    assert.equal(fetches, 2, 'the next 18:00 window refetches')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('createCbrCache keeps the last good file when the network fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dpb-cbr-'))
  const file = path.join(directory, 'cbr.json')
  const clock = temporaryClock(Date.UTC(2026, 10, 12, 16, 0, 0))
  let healthy = true
  const cache = createCbrCache({
    file,
    now: clock.now,
    log: () => {},
    fetchImpl: async () => {
      if (!healthy) throw new Error('offline')
      return xmlResponse(SAMPLE_XML)
    },
  })
  try {
    assert.equal((await cache.get()).ok, true)
    healthy = false
    const stale = await cache.get({ force: true })
    assert.equal(stale.ok, true)
    assert.equal(stale.stale, true)
    assert.equal(stale.data.rates.USD, 82.9803)
    assert.match(stale.error, /offline/)

    const empty = await createCbrCache({
      file: path.join(directory, 'absent.json'),
      now: clock.now,
      log: () => {},
      fetchImpl: async () => {
        throw new Error('offline')
      },
    }).get()
    assert.equal(empty.ok, false)
    assert.match(empty.error, /offline/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('createCbrCache backs off after a failed request-path fetch', async () => {
  const clock = temporaryClock(Date.UTC(2026, 10, 12, 16, 0, 0))
  const directory = await mkdtemp(path.join(tmpdir(), 'dpb-cbr-'))
  const file = path.join(directory, 'cbr.json')
  let fetches = 0
  const cache = createCbrCache({
    file,
    now: clock.now,
    log: () => {},
    fetchImpl: async () => {
      fetches += 1
      throw new Error('offline')
    },
  })
  try {
    const first = await cache.get()
    assert.equal(first.ok, false)
    assert.equal(fetches, 1)
    // Inside the backoff window a poll must not block on another 10s timeout.
    const second = await cache.get()
    assert.equal(second.ok, false)
    assert.equal(fetches, 1)
    // An explicit refresh still tries the network.
    await cache.get({ force: true })
    assert.equal(fetches, 2)
    // Past the backoff window a normal read retries by itself.
    clock.set(Date.UTC(2026, 10, 12, 16, 5, 0))
    await cache.get()
    assert.equal(fetches, 3)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a stale cache serves from memory during the failure backoff', async () => {
  const clock = temporaryClock(Date.UTC(2026, 10, 12, 16, 0, 0))
  const directory = await mkdtemp(path.join(tmpdir(), 'dpb-cbr-'))
  const file = path.join(directory, 'cbr.json')
  let fetches = 0
  let healthy = true
  const cache = createCbrCache({
    file,
    now: clock.now,
    log: () => {},
    fetchImpl: async () => {
      fetches += 1
      if (!healthy) throw new Error('offline')
      return xmlResponse(SAMPLE_XML)
    },
  })
  try {
    assert.equal((await cache.get()).ok, true)
    healthy = false
    // Move into the next 18:00 window so the file on disk is stale.
    clock.set(Date.UTC(2026, 10, 13, 16, 0, 0))
    const stale = await cache.get()
    assert.equal(stale.ok, true)
    assert.equal(stale.stale, true)
    assert.equal(fetches, 2)
    const served = await cache.get()
    assert.equal(served.ok, true)
    assert.equal(served.stale, true)
    assert.equal(fetches, 2, 'the backoff must serve the file without another request')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The host plugin reads the CBR document through global fetch; stub it before
// apply() so the route test never touches the network.
const CBR_XML = `<?xml version="1.0" encoding="windows-1251"?><ValCurs Date="13.11.2026" name="Foreign Currency Market"><Valute><CharCode>USD</CharCode><Nominal>1</Nominal><Value>82,9803</Value></Valute><Valute><CharCode>CNY</CharCode><Nominal>1</Nominal><Value>12,4009</Value></Valute></ValCurs>`

function xmlResponse() {
  const body = Buffer.from(CBR_XML, 'utf8')
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    },
  }
}

function createResponse() {
  return {
    status: 0,
    headersSent: false,
    body: null,
    writeHead(status) {
      this.status = status
      this.headersSent = true
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

function request(url) {
  return { method: 'GET', url, headers: { host: '127.0.0.1:3080' } }
}

function makeHost(directory) {
  const effects = []
  const routes = []
  const now = new Date(2026, 10, 12, 12, 0, 0).getTime()
  const opened = []
  const session = {
    async list() {
      return [
        { header: { id: 'session-a' }, revision: 'r1' },
        { header: { id: 'session-b' }, revision: 'r1' },
      ]
    },
    async open(id) {
      opened.push(id)
      const events =
        id === 'session-a'
          ? [
              { type: 'request/header', seq: 0, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
              { type: 'assistant/message', seq: 1, time: now, data: { usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 } } },
            ]
          : [
              { type: 'request/header', seq: 0, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
              { type: 'assistant/message', seq: 1, time: now, data: { usage: { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 } } },
            ]
      return {
        inheritedEventCount: 0,
        async read(offset = 0) {
          return { events: events.slice(offset) }
        },
        async close() {},
      }
    },
  }
  const account = {
    async getBalance() {
      return {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '60.00' }],
        bonusWallets: [{ currency: 'CNY', balance: '7.81' }],
      }
    },
  }
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    get(name) {
      return name === 'deepseekAccount' ? account : undefined
    },
    credentials: {
      async resolve() {
        return undefined
      },
    },
    sessionPersistence: session,
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, routes, opened, effects, restore: () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  } }
}

async function call(routes, url) {
  const route = routes.find((candidate) => candidate.path === '/api/platform-balance')
  const req = request(url)
  const res = createResponse()
  await route.handler(req, res)
  return { status: res.status, body: JSON.parse(res.body) }
}

test('host routes serve wallets, CBR RUB conversion, and session spend', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dpb-host-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => xmlResponse()
  const host = makeHost(directory)
  try {
    const { apply } = await import('../lib/index.js')
    apply(host.ctx)

    const overview = await call(host.routes, '/api/platform-balance/overview')
    assert.equal(overview.status, 200)
    assert.equal(overview.body.ok, true)
    const data = overview.body.data
    assert.equal(data.balance.source, 'account')
    assert.deepEqual(data.balance.wallets[0], {
      currency: 'CNY',
      total: '67.81',
      granted: '7.81',
      toppedUp: '60.00',
      rate: 12.4009,
      rub: 840.91,
    })
    assert.equal(data.balance.totalRub, 840.91)
    assert.equal(data.cbr.date, '13.11.2026')
    assert.equal(data.cbr.rates.USD, 82.9803)
    assert.equal(data.cbr.stale, false)
    // Peak weekday Flash: 1M input * 2 (session-a) + 1M output * 8 (session-b) = 10 CNY.
    assert.ok(Math.abs(data.spend.day.costCNY - 10) < 1e-9, `got ${data.spend.day.costCNY}`)
    assert.ok(Math.abs(data.spend.day.rub - 124.01) < 0.01)

    const session = await call(host.routes, '/api/platform-balance/session?id=session-a')
    assert.equal(session.status, 200)
    assert.equal(session.body.data.sessionId, 'session-a')
    assert.ok(Math.abs(session.body.data.costCNY - 2) < 1e-9)
    assert.ok(Math.abs(session.body.data.rub - 24.8) < 0.01)

    // force=1 bypasses the scanner's per-session TTL.
    const before = host.opened.length
    await call(host.routes, '/api/platform-balance/session?id=session-a&refresh=1')
    assert.ok(host.opened.length > before)

    const bad = await call(host.routes, '/api/platform-balance/session?id=../../etc/passwd')
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)

    const missing = await call(host.routes, '/api/platform-balance/unknown')
    assert.equal(missing.status, 404)
  } finally {
    for (const dispose of host.effects.reverse()) {
      try {
        dispose()
      } catch {}
    }
    host.restore()
    globalThis.fetch = originalFetch
    await rm(directory, { recursive: true, force: true })
  }
})

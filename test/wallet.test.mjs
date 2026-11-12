import assert from 'node:assert/strict'
import test from 'node:test'

import { accountClientMetadata, mergeWallets, readBalance } from '../lib/wallet.js'

test('mergeWallets combines recharge and bonus wallets per currency', () => {
  const merged = mergeWallets(
    [
      { currency: 'CNY', balance: '60.50' },
      { currency: 'USD', balance: '0.00' },
    ],
    [{ currency: 'CNY', balance: '7.31' }],
  )
  assert.deepEqual(merged, [
    { currency: 'CNY', total: '67.81', granted: '7.31', toppedUp: '60.50' },
    { currency: 'USD', total: '0.00', granted: '0.00', toppedUp: '0.00' },
  ])
})

test('mergeWallets skips rows without a currency or a numeric amount', () => {
  assert.deepEqual(mergeWallets([{ balance: '5' }, { currency: 'CNY', balance: 'nope' }], []), [])
})

test('accountClientMetadata carries a whole-second timezone offset', () => {
  const metadata = accountClientMetadata(() => new Date(Date.UTC(2026, 10, 12, 12, 0, 0)))
  assert.equal(typeof metadata.version, 'string')
  assert.equal(metadata.locale, 'en-US')
  assert.equal(Number.isInteger(metadata.timezoneOffsetSeconds), true)
})

test('readBalance prefers the signed-in account service', async () => {
  const ctx = {
    get: (service) =>
      service === 'deepseekAccount'
        ? {
            async getBalance() {
              return {
                status: 'ready',
                value: [{ currency: 'CNY', balance: '50.00' }],
                bonusWallets: [{ currency: 'CNY', balance: '17.81' }],
              }
            },
          }
        : undefined,
    credentials: {
      async resolve() {
        throw new Error('the API key must not be read when the account answers')
      },
    },
  }
  const result = await readBalance(ctx)
  assert.equal(result.ok, true)
  assert.equal(result.source, 'account')
  assert.deepEqual(result.wallets, [{ currency: 'CNY', total: '67.81', granted: '17.81', toppedUp: '50.00' }])
})

test('readBalance falls back to DEEPSEEK_API_KEY when the account is signed out', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: '10.00', granted_balance: '0.00', topped_up_balance: '10.00' },
            { currency: 'USD', total_balance: '1.00', granted_balance: '0.50', topped_up_balance: '0.50' },
          ],
        }
      },
    }
  }
  try {
    const result = await readBalance({
      get: () => ({ async getBalance() { return null } }),
      credentials: {
        async resolve(name) {
          assert.equal(name, 'DEEPSEEK_API_KEY')
          return { value: 'sk-test' }
        },
      },
    })
    assert.equal(result.ok, true)
    assert.equal(result.source, 'api-key')
    assert.equal(result.isAvailable, true)
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /api\.deepseek\.com\/user\/balance$/)
    assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')
    assert.deepEqual(result.wallets[0], { currency: 'CNY', total: '10.00', granted: '0.00', toppedUp: '10.00' })
    assert.equal(result.wallets[1].currency, 'USD')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('readBalance explains how to restore access when nothing answers', async () => {
  const result = await readBalance({
    get: () => ({ async getBalance() { return null } }),
    credentials: {
      async resolve() {
        return undefined
      },
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /DEEPSEEK_API_KEY/)
})

test('readBalance reports an HTTP failure from the balance endpoint', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 401 })
  try {
    const result = await readBalance({
      get: () => undefined,
      credentials: {
        async resolve() {
          return { value: 'sk-test' }
        },
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /401/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

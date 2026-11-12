/**
 * DeepSeek Platform wallet balances.
 *
 * Preferred source is the harness account service (`ctx.deepseekAccount`), which
 * reuses the browser login and needs no API key. When the account is not signed
 * in, the plugin falls back to the public balance endpoint authenticated with
 * DEEPSEEK_API_KEY. Both sources report one or more wallets, each with its own
 * currency (the Platform uses USD for international accounts and CNY otherwise).
 */

const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'
const REQUEST_TIMEOUT_MS = 20_000

function errorText(err) {
  return err instanceof Error ? err.message : String(err)
}

/** Client identity the account service forwards to the Platform. */
export function accountClientMetadata(clock = () => new Date()) {
  return {
    version: process.env.DSH_CLIENT_VERSION ?? '0.0.0',
    locale: 'en-US',
    timezoneOffsetSeconds: -clock().getTimezoneOffset() * 60,
  }
}

function fixed2(value) {
  return value.toFixed(2)
}

/**
 * Merge recharge and bonus wallet lists into one row per currency.
 *
 * @param {ReadonlyArray<{ currency?: string, balance?: string }>} toppedUpWallets - recharge wallets.
 * @param {ReadonlyArray<{ currency?: string, balance?: string }>} bonusWallets - granted/bonus wallets.
 * @returns {Array<{ currency: string, total: string, granted: string, toppedUp: string }>} merged wallets.
 */
export function mergeWallets(toppedUpWallets, bonusWallets) {
  const byCurrency = new Map()
  const add = (wallets, field) => {
    for (const wallet of wallets ?? []) {
      const currency = typeof wallet?.currency === 'string' ? wallet.currency : ''
      const amount = Number(wallet?.balance ?? '0')
      if (currency === '' || !Number.isFinite(amount)) continue
      const merged = byCurrency.get(currency) ?? { total: 0, granted: 0, toppedUp: 0 }
      merged[field] += amount
      merged.total += amount
      byCurrency.set(currency, merged)
    }
  }
  add(toppedUpWallets, 'toppedUp')
  add(bonusWallets, 'granted')
  return [...byCurrency].map(([currency, merged]) => ({
    currency,
    total: fixed2(merged.total),
    granted: fixed2(merged.granted),
    toppedUp: fixed2(merged.toppedUp),
  }))
}

async function readFromAccount(ctx) {
  const account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : undefined
  if (account === undefined || account === null || typeof account.getBalance !== 'function') {
    return { ok: false, reason: 'unavailable' }
  }
  try {
    const result = await account.getBalance(accountClientMetadata())
    if (result === null) return { ok: false, reason: 'signed-out' }
    if (result.status !== 'ready') return { ok: false, reason: 'failed' }
    return {
      ok: true,
      source: 'account',
      wallets: mergeWallets(result.value ?? [], result.bonusWallets ?? []),
    }
  } catch (err) {
    return { ok: false, reason: 'failed', error: errorText(err) }
  }
}

async function readFromApiKey(ctx) {
  if (ctx.credentials === undefined || typeof ctx.credentials.resolve !== 'function') {
    return { ok: false, error: 'Сервис учётных данных недоступен' }
  }
  let credential
  try {
    credential = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
  } catch (err) {
    return { ok: false, error: `Не удалось прочитать DEEPSEEK_API_KEY: ${errorText(err)}` }
  }
  if (credential === undefined || credential === null || credential.value === '') {
    return { ok: false, error: 'Нет доступа к балансу: войдите в аккаунт DeepSeek или задайте DEEPSEEK_API_KEY' }
  }
  let response
  try {
    response = await fetch(BALANCE_ENDPOINT, {
      headers: { authorization: `Bearer ${credential.value}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    return { ok: false, error: `Не удалось запросить баланс: ${errorText(err)}` }
  }
  if (!response.ok) return { ok: false, error: `Баланс: ответ HTTP ${response.status}` }
  let parsed
  try {
    parsed = await response.json()
  } catch (err) {
    return { ok: false, error: `Не удалось разобрать ответ баланса: ${errorText(err)}` }
  }
  const wallets = (Array.isArray(parsed?.balance_infos) ? parsed.balance_infos : []).map((wallet) => ({
    currency: typeof wallet?.currency === 'string' ? wallet.currency : '',
    total: typeof wallet?.total_balance === 'string' ? wallet.total_balance : '0',
    granted: typeof wallet?.granted_balance === 'string' ? wallet.granted_balance : '0',
    toppedUp: typeof wallet?.topped_up_balance === 'string' ? wallet.topped_up_balance : '0',
  }))
  return {
    ok: true,
    source: 'api-key',
    isAvailable: parsed?.is_available === true,
    wallets: wallets.filter((wallet) => wallet.currency !== ''),
  }
}

/**
 * Read the current Platform wallets.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @returns {Promise<{ ok: true, source: 'account' | 'api-key', isAvailable: boolean, wallets: Array<object> } | { ok: false, error: string }>} balance outcome.
 */
export async function readBalance(ctx) {
  const account = await readFromAccount(ctx)
  if (account.ok) {
    return {
      ok: true,
      source: 'account',
      isAvailable: account.wallets.length > 0,
      wallets: account.wallets,
    }
  }
  const apiKey = await readFromApiKey(ctx)
  if (apiKey.ok) {
    return {
      ok: true,
      source: 'api-key',
      isAvailable: apiKey.isAvailable ?? apiKey.wallets.length > 0,
      wallets: apiKey.wallets,
    }
  }
  return { ok: false, error: apiKey.error }
}

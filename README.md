# dsh-platform-balance

[English](README.md) | [Русский](README.ru.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) Web GUI plugin: it shows the current
DeepSeek Platform wallet balance in every currency the platform reports (USD and CNY),
converts it into Russian rubles at the official Central Bank of Russia (CBR) rate, and shows
estimated spend for the current session and for the current day.

Two pieces of UI appear:

- **a floating card** in the bottom-right corner — one row per wallet, the total in RUB, the CBR
  rate with its quote date and refresh time, and session/day spend in CNY and RUB. The card
  collapses to a single line and lifts itself above the message composer so it never covers the
  send button;
- **a pill in the header of an open session** — `≈ 153 ₽ · session 5.58 ₽ · day 15.25 ₽`.
  Clicking it collapses or expands the card. The pill exists only inside a conversation; the
  card is visible on every screen.

## Data sources

| What | Where it comes from |
|---|---|
| Balance | DSH account service (`deepseekAccount.getBalance`, browser sign-in, no API key); when the account is signed out — `DEEPSEEK_API_KEY` via `https://api.deepseek.com/user/balance` |
| CBR rate | Official CBR XML feed `https://www.cbr.ru/scripts/XML_daily.asp`, USD and CNY against RUB |
| Spend | DSH session logs (`ctx.sessionPersistence`): request token usage × official DeepSeek prices in CNY, billed only for requests routed through the DeepSeek platform |

The plugin sends no data anywhere except two requests: the CBR feed (for the rate) and, when
there is no signed-in account, `api.deepseek.com` (for the balance). Its HTTP routes are
loopback-only and same-origin, so another browser tab cannot read the balance.

## CBR rate and its cache

- The rate is stored in `$DSH_HOME/cache/platform-balance/cbr.json` (default
  `~/.dsh/cache/platform-balance/cbr.json`) and survives restarts.
- It is refreshed every day at **18:00 Moscow time** (a host-side timer). The same instant is
  the freshness boundary of the cache.
- With no cache file the rate is fetched on the first request (and warmed once right after the
  plugin starts).
- When the network is unavailable, the last saved rate stays on screen and is marked as stale:
  the rate rows and RUB conversions remain visible. After a failed fetch, requests back off for
  2 minutes so a one-minute poll never waits on a 10-second timeout each time; a background retry
  happens 15 minutes later and the refresh button tries immediately.
- Only USD, CNY, and the currencies of the platform wallets are sent to the browser; the cache
  file keeps the full CBR document.

## Spend is an estimate

DeepSeek does not expose a request's cost in the session log, so spend is estimated from token
counts and the official DeepSeek CNY price list, taking into account:

- peak and off-peak hours (peak is 09:00–12:00 and 14:00–18:00 Beijing time, ×2 price);
- the switch to peak pricing on 2026-08-17;
- the Flash price cut on 2026-09-10 (and peak pricing on weekdays only);
- `deepseek-v4-pro` requests being served at Flash prices from 2026-09-14.

The price table lives in [`lib/pricing.js`](lib/pricing.js); when DeepSeek changes its prices,
that is the only file to update. Numbers in the UI are prefixed with `≈`: this is an estimate,
not a bill.

Only DeepSeek platform routes are priced: a request is billed when its provider is DeepSeek
(`deepseek-account`, `deepseek-official`, or any provider id containing `deepseek`). Sessions
running on other providers — a local `ollama`, a free third-party gateway, another API — never
spend the platform balance, so their requests are not priced at all, even when the model id
looks like a DeepSeek model (`opencode-go` serving `deepseek-v4.1-flash` is still not the
platform). Such requests are reported separately as `otherCalls`/`otherTokens`, add nothing to
the money totals, and the widget notes them as "not DeepSeek".

Paid summarization calls (`compaction/summary`) are included. Forked sessions (subagents with an
inherited history) skip the copied parent prefix in their log, so the daily total is not counted
twice and a forked session reports only its own work.

The "day" is the local calendar day of the machine running DSH (Europe/Moscow, for example). It covers every stored session, including subagent sessions, with inherited fork
prefixes excluded. Day totals are cached per session revision and per calendar day, so a repeated
request re-reads only changed logs and a midnight rollover re-aggregates the cached day buckets
without re-reading the whole session corpus.

## Install

The plugin is a regular DSH bundle package:

```sh
# from the git repository
dsh plugin --profile web add github:keltanas/dsh-platform-balance

# or from a local checkout
dsh plugin --profile web add ~/projects/dsh-platform-balance
```

`dsh plugin` (a pnpm wrapper) adds the dependency and appends the bundle to
`~/.dsh/profiles/web/package.json`. The profile then reloads itself (`patchReload: live`) and an
open page picks up the browser half over HMR; a restart of `dsh web` is not needed for a first
install. If host-half source code changes later, Node caches the imported module, so restart
`dsh web` (for example `systemctl --user restart dsh.service`) to apply those changes.

Verify without a browser:

```sh
curl -s http://127.0.0.1:3080/api/platform-balance/overview | jq .
curl -s "http://127.0.0.1:3080/api/platform-balance/session?id=<session-id>" | jq .
```

Remove:

```sh
dsh plugin --profile web remove dsh-platform-balance
```

### Compatibility with dsh-usage-dashboard

If `@cassius0924/dsh-usage-dashboard` is installed, its floating widget duplicates the balance
card — keep only one of them. Bring that plugin back with
`dsh plugin --profile web add @cassius0924/dsh-usage-dashboard@0.9.2`.

## HTTP API

All routes are `GET`, loopback-only and same-origin, with `cache-control: no-store`.

`GET /api/platform-balance/overview[?refresh=1]`

```json
{
  "ok": true,
  "data": {
    "generatedAt": 1790000000000,
    "balance": {
      "source": "account",
      "isAvailable": true,
      "wallets": [
        { "currency": "USD", "total": "0.00", "granted": "0.00", "toppedUp": "0.00", "rate": 82.9803, "rub": 0 },
        { "currency": "CNY", "total": "12.34", "granted": "0.00", "toppedUp": "12.34", "rate": 12.4009, "rub": 153.03 }
      ],
      "totalRub": 153.03
    },
    "cbr": {
      "date": "13.11.2026",
      "fetchedAt": 1790000000000,
      "stale": false,
      "rates": { "USD": 82.9803, "CNY": 12.4009 },
      "error": null
    },
    "spend": {
      "currency": "CNY",
      "estimated": true,
      "pricing": { "...": "current price era table" },
      "day": { "dayKey": "2026-11-12", "costCNY": 2.5, "rub": 31.0, "calls": 37, "tokens": 1234567, "otherCalls": 5, "otherTokens": 42000 }
    }
  }
}
```

`GET /api/platform-balance/session?id=<sessionId>`

```json
{
  "ok": true,
  "data": {
    "sessionId": "session-...",
    "currency": "CNY",
    "estimated": true,
    "costCNY": 0.45,
    "rub": 5.58,
    "calls": 12,
    "tokens": 34567,
    "otherCalls": 0,
    "otherTokens": 0,
    "lastAt": 1790000000000
  }
}
```

Errors always come as `{ "ok": false, "error": "text" }`.

## Layout

```
lib/index.js      host plugin: HTTP routes, TTL caches, CBR timer, cache warm-up
lib/cbr.js        CBR XML fetch/parse, on-disk cache, 18:00 MSK schedule
lib/wallet.js     account balance with a DEEPSEEK_API_KEY fallback
lib/usage.js      session-log reading, per-session and per-day cost aggregation
lib/pricing.js    official DeepSeek prices and peak/off-peak windows
lib/http.js       JSON responses and same-origin checks
lib/client.js     browser half: React card and header pill
cordis.patch.yml  bundle layer: one Loader row carrying both halves
test/             node:test — CBR, prices, usage aggregation, wallets, HTTP, host routes
```

The host half uses the `webServer`, `credentials`, and `sessionPersistence` services plus the
optional `deepseekAccount` service. The browser half needs no npm dependencies: React and
`react/jsx-runtime` come from the DSH shared module table.

## Development

```sh
git clone https://github.com/keltanas/dsh-platform-balance.git
cd dsh-platform-balance
node --test                # 38 tests, no network required
node --check lib/*.js      # syntax check
```

After editing `lib/client.js`, refresh the page: HMR rebuilds the bundle from the file's mtime.
Host-half edits are cached by Node after the first import and apply on the next `dsh web` restart.

## Limitations

- Spend is an estimate, not billing; the price table can lag behind DeepSeek price changes.
- A custom provider that proxies DeepSeek under an id without `deepseek` in it is treated as a
  third party and is not billed.
- A wallet whose currency has no CBR rate converts to `null` (`— ₽` in the UI).
- No balance history or "days left" forecast.
- The day boundary follows the DSH host's time zone, not the browser's.
- A `link:` install keeps the checkout path as a runtime requirement; a git install is
  self-contained.
- The HTTP routes accept loopback hosts only; a non-loopback DSH bind exposes no balance API.

## License

MIT — see [LICENSE](LICENSE).

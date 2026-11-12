import assert from 'node:assert/strict'
import test from 'node:test'

import { isTrustedApiRequest, writeJson } from '../lib/http.js'

function request(overrides) {
  return { headers: {}, method: 'GET', url: '/', ...overrides }
}

test('isTrustedApiRequest accepts loopback same-origin requests', () => {
  assert.equal(isTrustedApiRequest(request({ headers: { host: '127.0.0.1:3080' } })), true)
  assert.equal(
    isTrustedApiRequest(request({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } })),
    true,
  )
  assert.equal(isTrustedApiRequest(request({ headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } })), true)
})

test('isTrustedApiRequest rejects foreign Host, foreign Origin, and cross-site fetches', () => {
  assert.equal(isTrustedApiRequest(request({ headers: {} })), false)
  assert.equal(isTrustedApiRequest(request({ headers: { host: '192.0.2.5:3080' } })), false)
  assert.equal(
    isTrustedApiRequest(request({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } })),
    false,
  )
  assert.equal(
    isTrustedApiRequest(request({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } })),
    false,
  )
  assert.equal(isTrustedApiRequest(request({ headers: { host: 'bad host' } })), false)
})

test('writeJson writes one JSON response', () => {
  const captured = {}
  const response = {
    headersSent: false,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(body) {
      captured.body = body
    },
  }
  writeJson(response, 200, { ok: true }, { 'cache-control': 'no-store' })
  assert.equal(captured.status, 200)
  assert.equal(captured.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(captured.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(captured.body), { ok: true })
})

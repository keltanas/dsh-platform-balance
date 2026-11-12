/**
 * Small HTTP helpers for the plugin's loopback JSON routes.
 *
 * The Web server binds to loopback by default, but the routes still reject
 * cross-site browser requests so a random page can never read the wallet
 * balances. Only same-origin requests from a loopback Host are accepted.
 */

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

/**
 * Whether one incoming request is a same-origin loopback request.
 *
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {boolean} true when the request may read the JSON payload.
 */
export function isTrustedApiRequest(req) {
  const host = req.headers.host
  if (host === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} res - response to own.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable body.
 * @param {Record<string, string>} [headers] - extra response headers.
 */
export function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

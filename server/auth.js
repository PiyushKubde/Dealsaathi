// An access password for a hosted copy: one shared password, a signed session cookie, login attempts limited.
// Locally (no password set) the app stays open to this computer only.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { AppError } from './errors.js'

const COOKIE = 'ds_session'
const SESSION_MS = 12 * 60 * 60 * 1000
const MAX_ATTEMPTS = 10
const WINDOW_MS = 15 * 60 * 1000
const MIN_PASSWORD = 12

const sha256 = (s) => createHash('sha256').update(s).digest()

/**
 * mode 'open': no password needed (local use).
 * mode 'password': every /api call but health and login needs a session.
 * mode 'locked': hosted without APP_PASSWORD, so every /api call but health is refused.
 */
export function createAuth({ password, hosted }) {
  const usable = typeof password === 'string' && password.length >= MIN_PASSWORD
  const mode = usable ? 'password' : hosted ? 'locked' : 'open'
  // The signing key follows the password: changing APP_PASSWORD signs everyone out.
  const key = usable ? sha256(`dealsaathi-session:${password}`) : randomBytes(32)
  const attempts = new Map()

  const sign = (expires) => createHmac('sha256', key).update(String(expires)).digest('base64url')

  function readSession(req) {
    const raw = (req.get('cookie') || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))
    if (!raw) return false
    const [expires, mac] = raw.slice(COOKIE.length + 1).split('.')
    if (!expires || !mac || Number(expires) < Date.now()) return false
    const expected = Buffer.from(sign(expires))
    const given = Buffer.from(mac)
    return expected.length === given.length && timingSafeEqual(expected, given)
  }

  function cookie(req, value, maxAgeSeconds) {
    const secure = req.secure ? '; Secure' : ''
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`
  }

  /** Too many wrong passwords from one address: wait. */
  function checkRate(ip) {
    const now = Date.now()
    const entry = attempts.get(ip)
    if (!entry || entry.resetAt < now) return
    if (entry.count >= MAX_ATTEMPTS) throw new AppError(429, 'too_many_attempts', 'Too many wrong passwords. Wait 15 minutes and try again.')
  }
  function recordFailure(ip) {
    const now = Date.now()
    const entry = attempts.get(ip)
    if (!entry || entry.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    else entry.count++
  }

  return {
    mode,

    status(req) {
      return { mode, hosted: Boolean(hosted), signedIn: mode === 'open' || (mode === 'password' && readSession(req)) }
    },

    /** Guards /api: health and the session routes are always reachable. */
    guard(req, res, next) {
      if (req.path === '/health' || req.path.startsWith('/session')) return next()
      if (mode === 'open') return next()
      if (mode === 'locked') return next(new AppError(503, 'password_not_set', 'This hosted copy is locked until APP_PASSWORD (at least 12 characters) is set in the hosting settings.'))
      if (readSession(req)) return next()
      next(new AppError(401, 'login_required', 'Please sign in.'))
    },

    login(req, res) {
      if (mode === 'open') return res.json({ signedIn: true, mode })
      if (mode === 'locked') throw new AppError(503, 'password_not_set', 'This hosted copy is locked until APP_PASSWORD (at least 12 characters) is set in the hosting settings.')
      const ip = req.ip || 'unknown'
      checkRate(ip)
      const given = req.body?.password
      if (typeof given !== 'string' || given.length > 200 || !timingSafeEqual(sha256(given), sha256(password))) {
        recordFailure(ip)
        throw new AppError(401, 'wrong_password', 'That password is not right.')
      }
      attempts.delete(ip)
      const expires = Date.now() + SESSION_MS
      res.setHeader('Set-Cookie', cookie(req, `${expires}.${sign(expires)}`, SESSION_MS / 1000))
      res.json({ signedIn: true, mode })
    },

    logout(req, res) {
      res.setHeader('Set-Cookie', cookie(req, '', 0))
      res.json({ signedIn: false, mode })
    }
  }
}

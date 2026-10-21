import crypto from 'node:crypto'
import { audit } from './db.js'

const SESSION_COOKIE = 'ds_session'
const SESSION_DAYS = 7

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length)
  return crypto.timingSafeEqual(actual, expected)
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

/**
 * The workspace owner comes from DEALSAATHI_ADMIN_EMAIL / DEALSAATHI_ADMIN_PASSWORD. On every start the
 * stored hash is brought in line with the configured password, so rotating it in the environment works.
 */
export function ensureAdmin(db, admin) {
  if (!admin.email || !admin.password) return null
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(admin.email)
  if (!existing) {
    const info = db
      .prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)')
      .run(admin.email, admin.name, hashPassword(admin.password))
    return info.lastInsertRowid
  }
  if (!verifyPassword(admin.password, existing.password_hash)) {
    db.prepare('UPDATE users SET password_hash = ?, name = ? WHERE id = ?').run(hashPassword(admin.password), admin.name, existing.id)
  }
  return existing.id
}

function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString()
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires)
  return { token, expires }
}

export function sessionCookie(token, { production, clear = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${clear ? 0 : SESSION_DAYS * 86400}`
  ]
  if (production) parts.push('Secure')
  return parts.join('; ')
}

export function authMiddleware(db) {
  const lookup = db.prepare(
    `SELECT users.id, users.email, users.name, sessions.expires_at
       FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?`
  )
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (token) {
      const row = lookup.get(sha256(token))
      if (row && row.expires_at > new Date().toISOString()) {
        req.user = { id: row.id, email: row.email, name: row.name }
        req.sessionTokenHash = sha256(token)
      }
    }
    next()
  }
}

export function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.', code: 'unauthenticated' })
  next()
}

/**
 * State-changing requests must carry the X-DealSaathi header. A cross-site form or image cannot set a
 * custom header, so together with the SameSite cookie this blocks CSRF without a token round-trip.
 */
export function requireAppHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.get('X-DealSaathi') !== '1') return res.status(403).json({ error: 'Missing request header.', code: 'csrf' })
  next()
}

export function login(db, email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase())
  // Always run one scrypt so a missing account and a wrong password take the same time.
  const ok = user ? verifyPassword(String(password || ''), user.password_hash) : (verifyPassword('x', hashPassword('y')), false)
  if (!ok) {
    audit(db, user?.id, 'login_failed')
    return null
  }
  audit(db, user.id, 'login')
  return { id: user.id, email: user.email, name: user.name }
}

export function logout(db, tokenHash) {
  if (tokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
}

/** A small fixed-window limiter for the login endpoint, keyed by client IP. */
export function loginRateLimiter({ max = 10, windowMs = 15 * 60_000 } = {}) {
  const hits = new Map()
  return (req, res, next) => {
    const key = req.ip
    const now = Date.now()
    const entry = hits.get(key)
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs })
      return next()
    }
    entry.count += 1
    if (entry.count > max) return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' })
    next()
  }
}

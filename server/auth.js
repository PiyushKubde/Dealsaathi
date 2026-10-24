// Accounts and sessions. Each person has a stable id (usr_…), never their email: it is also the
// unique_identifier viaSocket scopes their connections, flows and AI threads by.
// A hosted copy is reachable from the internet, so creating an account there needs the team access
// code (APP_PASSWORD); without one set, the hosted copy stays locked.
import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { now, transaction } from './db.js'
import { AppError, validationError } from './errors.js'

const COOKIE = 'ds_session'
const SESSION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ATTEMPTS = 10 // failed sign-ins per IP address per 15 minutes
const MAX_ACCOUNT_ATTEMPTS = 20 // failed sign-ins per account per 15 minutes, from any address
const MAX_SIGNUPS = 20 // new accounts per IP address per hour
const WINDOW_MS = 15 * 60 * 1000
export const MIN_ACCESS_CODE = 12
const MIN_PASSWORD = 10
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const sha256 = (s) => createHash('sha256').update(s).digest()
const sha256hex = (s) => createHash('sha256').update(s).digest('hex')

export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length)
  return timingSafeEqual(expected, actual)
}

// The sign-in and sign-up routes hash on libuv's thread pool, so a burst of sign-ins does not stall every other request.
const scryptAsync = promisify(scrypt)
export async function hashPasswordAsync(password) {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 32)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPasswordAsync(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length)
  return timingSafeEqual(expected, actual)
}

// Checked when the email has no account, so an unknown address takes as long to refuse as a wrong password.
let dummyHash = null
const timingDummy = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')))

/** Drops expired entries from a rate-limit map once it grows, so many distinct addresses cannot exhaust memory. */
export function sweepExpired(map, max = 5000, field = 'resetAt') {
  if (map.size < max) return
  const t = Date.now()
  for (const [key, entry] of map) if (entry[field] < t) map.delete(key)
}

export const ROLES = ['buyer', 'seller', 'agent']
const publicUser = (u) => (u ? { id: u.id, name: u.name, email: u.email, role: u.role, emailVerified: Boolean(u.email_verified_at) } : null)

/** The checked fields of a new account; throws 400 listing every field that needs attention. */
function cleanNewUser({ name, email, password, role = 'agent', phone = null }) {
  const errors = {}
  const cleanName = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (cleanName.length < 2 || cleanName.length > 80) errors.name = 'Enter your name.'
  if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 200) errors.email = 'Enter a valid email address.'
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) errors.password = `Use at least ${MIN_PASSWORD} characters.`
  if (!ROLES.includes(role)) errors.role = 'Choose Buyer, Seller or Agent.'
  const cleanPhone = typeof phone === 'string' && phone.trim() ? phone.trim().slice(0, 20) : null
  if (cleanPhone && !/^[+\d][\d\s-]{6,19}$/.test(cleanPhone)) errors.phone = 'Enter a valid phone number.'
  if (Object.keys(errors).length) throw validationError(errors)
  return { cleanName, cleanEmail, role, cleanPhone }
}

/**
 * Creates an account with its role and the matching profile, in one transaction.
 * Throws 400 for bad fields and 409 if the email is taken. `passwordHash`: already hashed (see register).
 */
export function createUser(db, { name, email, password, role = 'agent', phone = null, passwordHash = null }) {
  const { cleanName, cleanEmail, cleanPhone } = cleanNewUser({ name, email, password, role, phone })
  return transaction(db, () => {
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanEmail)) throw new AppError(409, 'email_taken', 'An account with this email already exists. Sign in instead.')
    const user = { id: `usr_${randomBytes(9).toString('hex')}`, email: cleanEmail, name: cleanName, role }
    const ts = now()
    db.prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, user.email, user.name, passwordHash ?? hashPassword(password), role, ts)
    const table = { agent: 'agent_profiles', buyer: 'buyer_profiles', seller: 'seller_profiles' }[role]
    db.prepare(`INSERT INTO ${table} (user_id, phone, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(user.id, cleanPhone, ts, ts)
    return user
  })
}

/** A new session for the user; returns the raw token (only its hash is stored). */
export function createSession(db, userId) {
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256hex(token), userId, new Date(Date.now() + SESSION_MS).toISOString(), now())
  return token
}

export const sessionCookie = (token) => `${COOKIE}=${token}`

/**
 * mode 'accounts': every /api call but health and the session routes needs a signed-in user.
 * mode 'locked': hosted without a usable APP_PASSWORD, so everything but health is refused.
 */
export function createAuth({ db, accessCode, hosted = false }) {
  const codeUsable = typeof accessCode === 'string' && accessCode.length >= MIN_ACCESS_CODE
  const mode = hosted && !codeUsable ? 'locked' : 'accounts'
  const attempts = new Map()
  const signups = new Map() // ip → { count, resetAt }: open signup for buyers and sellers is capped per address

  function tokenFrom(req) {
    const raw = (req.get('cookie') || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))
    return raw ? raw.slice(COOKIE.length + 1) : null
  }

  function currentUser(req) {
    const token = tokenFrom(req)
    if (!token || token.length > 100) return null
    const row = db.prepare('SELECT u.* , s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha256hex(token))
    if (!row) return null
    if (row.expires_at < now()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256hex(token))
      return null
    }
    return publicUser(row)
  }

  const cookie = (req, value, maxAgeSeconds) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${req.secure ? '; Secure' : ''}`

  // Failed attempts are counted per IP address and, for sign-in, per account. A successful sign-in clears only that
  // account's count: clearing the address's count would let someone with one account reset it between guesses.
  function checkRate(key, max = MAX_ATTEMPTS) {
    const entry = attempts.get(key)
    if (entry && entry.resetAt > Date.now() && entry.count >= max) {
      throw new AppError(429, 'too_many_attempts', 'Too many attempts. Wait 15 minutes and try again.')
    }
  }
  function recordFailure(key) {
    sweepExpired(attempts)
    const entry = attempts.get(key)
    if (!entry || entry.resetAt < Date.now()) attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS })
    else entry.count++
  }
  // Sign-in counts an attempt before the (asynchronous) password check, so parallel guesses cannot all slip in
  // under the limit while the hashes run; a correct password takes its attempt back.
  function takeBack(key) {
    const entry = attempts.get(key)
    if (entry && entry.count > 0) entry.count--
  }
  const lockedError = () => new AppError(503, 'password_not_set', `This hosted copy is locked until APP_PASSWORD (at least ${MIN_ACCESS_CODE} characters) is set in the hosting settings.`)

  function startSession(req, res, user) {
    const token = createSession(db, user.id)
    res.setHeader('Set-Cookie', cookie(req, token, SESSION_MS / 1000))
    res.json({ mode, hosted, user: publicUser(user) })
  }

  return {
    mode,

    status(req) {
      const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n
      return { mode, hosted, user: mode === 'locked' ? null : currentUser(req), hasUsers: users > 0, registrationNeedsCode: hosted, agentCodeRequired: hosted }
    },

    /** Guards /api: health and the session routes are always reachable. Sets req.user. */
    guard(req, res, next) {
      if (req.path === '/health' || req.path === '/session' || req.path.startsWith('/session/') || req.path.startsWith('/public/')) return next()
      if (mode === 'locked') return next(lockedError())
      const user = currentUser(req)
      if (!user) return next(new AppError(401, 'login_required', 'Please sign in.'))
      req.user = user
      next()
    },

    async register(req, res) {
      if (mode === 'locked') throw lockedError()
      const ip = req.ip || 'unknown'
      checkRate(ip)
      const { name, email, password, phone, role, accessCode: given } = req.body || {}
      // Agents see leads' contact details, so on a hosted copy only people with the team access code can be agents.
      // Buyers and sellers sign up openly.
      if (hosted && role === 'agent') {
        const ok = typeof given === 'string' && given.length <= 200 && timingSafeEqual(sha256(given), sha256(accessCode))
        if (!ok) {
          recordFailure(ip)
          throw new AppError(401, 'wrong_access_code', 'That team access code is not right. Ask the person who set up DealSaathi.')
        }
      }
      const s = signups.get(ip)
      if (s && s.resetAt > Date.now() && s.count >= MAX_SIGNUPS) throw new AppError(429, 'too_many_signups', 'Too many new accounts from this network. Try again in an hour.')
      const clean = cleanNewUser({ name, email, password, phone, role })
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(clean.cleanEmail)) throw new AppError(409, 'email_taken', 'An account with this email already exists. Sign in instead.')
      // The signup is counted before the password is hashed (parallel requests cannot all pass the check) and
      // handed back if the account is not created after all.
      sweepExpired(signups)
      if (!s || s.resetAt < Date.now()) signups.set(ip, { count: 1, resetAt: Date.now() + 60 * 60 * 1000 })
      else s.count++
      let user
      try {
        const passwordHash = await hashPasswordAsync(password)
        user = createUser(db, { name, email, password, phone, role, passwordHash }) // re-checks the email inside its transaction
      } catch (error) {
        const entry = signups.get(ip)
        if (entry && entry.count > 0) entry.count--
        throw error
      }
      startSession(req, res, user)
    },

    async login(req, res) {
      if (mode === 'locked') throw lockedError()
      const ip = req.ip || 'unknown'
      const { email, password } = req.body || {}
      const clean = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 200) : ''
      const account = `account:${clean}`
      checkRate(ip)
      checkRate(account, MAX_ACCOUNT_ATTEMPTS)
      recordFailure(ip)
      if (clean) recordFailure(account)
      const row = clean ? db.prepare('SELECT * FROM users WHERE email = ?').get(clean) : null
      const usable = typeof password === 'string' && password.length <= 200
      const ok = usable && (await verifyPasswordAsync(password, row ? row.password_hash : timingDummy())) && Boolean(row)
      if (!ok) throw new AppError(401, 'wrong_password', 'That email and password do not match.')
      takeBack(ip)
      attempts.delete(account)
      startSession(req, res, row)
    },

    logout(req, res) {
      const token = tokenFrom(req)
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256hex(token))
      res.setHeader('Set-Cookie', cookie(req, '', 0))
      res.json({ mode, hosted, user: null })
    }
  }
}

// Email verification and password reset. Both send a one-time link (32 random bytes; only its SHA-256 is stored),
// expire, are single-use, and a newer link replaces an older one. A reset signs the person out everywhere.
import { createHash, randomBytes } from 'node:crypto'
import { now, transaction } from './db.js'
import { AppError, validationError } from './errors.js'
import { hashPassword } from './auth.js'
import { linkVerifiedAccount } from './rent/service.js'

const sha = (t) => createHash('sha256').update(t).digest('hex')
const TTL = { verify_email: 48 * 3600 * 1000, reset_password: 30 * 60 * 1000 }
const PER_HOUR = { verify_email: 5, reset_password: 3 }
const MIN_PASSWORD = 10

/** A new token for this purpose; older unused ones stop working. Null when too many were issued this hour. */
function issue(db, userId, purpose) {
  const recent = db.prepare('SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = ? AND created_at > ?').get(userId, purpose, new Date(Date.now() - 3600 * 1000).toISOString()).n
  if (recent >= PER_HOUR[purpose]) return null
  const token = randomBytes(32).toString('base64url')
  const ts = now()
  const id = transaction(db, () => {
    db.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(ts, userId, purpose)
    return Number(db.prepare('INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, purpose, sha(token), new Date(Date.now() + TTL[purpose]).toISOString(), ts).lastInsertRowid)
  })
  return { token, id }
}

/** Marks a valid token used and returns its row; anything else is one indistinct error. */
function consume(db, token, purpose) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new AppError(400, 'invalid_link', 'This link is not valid or has expired. Ask for a new one.')
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ?').get(sha(token), purpose)
  if (!row || row.used_at || row.expires_at < now()) throw new AppError(400, 'invalid_link', 'This link is not valid or has expired. Ask for a new one.')
  const r = db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), row.id)
  if (!r.changes) throw new AppError(400, 'invalid_link', 'This link is not valid or has expired. Ask for a new one.')
  return row
}

export function verificationState(db, userId) {
  const u = db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(userId)
  return { emailVerified: Boolean(u?.email_verified_at), emailVerifiedAt: u?.email_verified_at ?? null }
}

export async function sendVerification(db, mailer, user, base) {
  if (verificationState(db, user.id).emailVerified) throw new AppError(409, 'already_verified', 'Your email address is already verified.')
  const mail = mailer.status()
  if (!mail.available) throw new AppError(503, 'mail_unavailable', 'Email verification is not available on this server yet: no system email account is set up. Ask the person who runs DealSaathi.')
  const t = issue(db, user.id, 'verify_email')
  if (!t) throw new AppError(429, 'too_many_requests', 'Too many verification emails this hour. Try again later.')
  const out = await mailer.send({
    to: user.email, toUserId: user.id, kind: 'verify_email', subject: 'Confirm your email for DealSaathi', dedupeKey: `verify_email:${t.id}`,
    body: `Hi ${user.name.split(' ')[0]},\n\nPlease confirm this is your email address by opening this link within 48 hours:\n${base}/#/verify-email/${t.token}\n\nIf you did not create a DealSaathi account, ignore this email.\n\nDealSaathi`
  })
  if (out.status !== 'sent') throw new AppError(502, 'mail_failed', `The verification email could not be sent: ${out.reason}`)
  return { sent: true }
}

/** Confirms the email; tenancies already waiting for this verified address are linked. */
export function verifyEmail(db, token) {
  const row = consume(db, token, 'verify_email')
  db.prepare('UPDATE users SET email_verified_at = coalesce(email_verified_at, ?) WHERE id = ?').run(now(), row.user_id)
  const linked = linkVerifiedAccount(db, row.user_id)
  return { verified: true, tenanciesLinked: linked }
}

/** Always the same answer, whether or not the email has an account (no account discovery). */
export async function requestPasswordReset(db, mailer, email, base) {
  const mail = mailer.status()
  if (!mail.available) throw new AppError(503, 'mail_unavailable', 'Password reset by email is not available on this server yet. Ask the person who runs DealSaathi.')
  const clean = typeof email === 'string' ? email.trim().toLowerCase() : ''
  const user = clean ? db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(clean) : null
  if (user) {
    const t = issue(db, user.id, 'reset_password')
    if (t) {
      await mailer.send({
        to: user.email, toUserId: user.id, kind: 'reset_password', subject: 'Reset your DealSaathi password', dedupeKey: `reset_password:${t.id}`,
        body: `Hi ${user.name.split(' ')[0]},\n\nSomeone asked to reset your DealSaathi password. If it was you, open this link within 30 minutes:\n${base}/#/reset-password/${t.token}\n\nIf it was not you, ignore this email: your password stays the same.\n\nDealSaathi`
      })
    }
  }
  return { message: 'If an account uses that email, a reset link is on its way. It works for 30 minutes.' }
}

export function resetPassword(db, token, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) throw validationError({ password: `Use at least ${MIN_PASSWORD} characters.` })
  const row = consume(db, token, 'reset_password')
  transaction(db, () => {
    // Opening the emailed link also proves the address belongs to them.
    db.prepare('UPDATE users SET password_hash = ?, email_verified_at = coalesce(email_verified_at, ?) WHERE id = ?').run(hashPassword(password), now(), row.user_id)
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id)
    db.prepare("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'reset_password' AND used_at IS NULL").run(now(), row.user_id)
  })
  linkVerifiedAccount(db, row.user_id)
  return { reset: true }
}

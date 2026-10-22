// System email (verification links, password resets) sent through one Gmail connection the operator designates:
// SYSTEM_MAIL_CONNECTION is the DealSaathi id of an agent's connected Gmail account (shown on the Integrations page).
// Without it, these emails cannot be sent, and the app says so instead of pretending.
import { gmailInput, readGmailResult, runOnce } from './integrations/run.js'
import { claimExternal, finishExternal } from './notifications/service.js'

export function createMailer({ db, vs, connectionId = null }) {
  // A function lets the operator's choice be read at send time (tests set it after connecting an account).
  const current = () => { const v = typeof connectionId === 'function' ? connectionId() : connectionId; return v == null || v === '' ? null : Number(v) }

  function sender() {
    const id = current()
    if (!id || !Number.isInteger(id)) return { ok: false, reason: 'No system email account is set on this server (SYSTEM_MAIL_CONNECTION).' }
    if (!vs.configured) return { ok: false, reason: 'viaSocket is not configured on this server.' }
    const row = db.prepare("SELECT c.id, c.user_id FROM connections c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND u.role = 'agent'").get(id)
    if (!row) return { ok: false, reason: 'The system email account (SYSTEM_MAIL_CONNECTION) is not an agent’s connected Gmail account.' }
    return { ok: true, userId: row.user_id, connectionId: row.id }
  }

  return {
    status: () => { const s = sender(); return { available: s.ok, reason: s.ok ? null : s.reason } },

    /**
     * Sends one email. `dedupeKey` names the fact (e.g. the token row), so a retried request never sends twice.
     * Returns { status: 'sent' | 'failed' | 'unknown' | 'unavailable', messageId?, reason? }; the body is not stored.
     */
    async send({ to, toUserId, kind, subject, body, dedupeKey }) {
      const s = sender()
      if (!s.ok) return { status: 'unavailable', reason: s.reason }
      const claim = claimExternal(db, toUserId, 'gmail', { kind, title: subject, dedupeKey })
      if (!claim) return { status: 'unknown', reason: 'This email was already sent or is being sent.' }
      const ran = await runOnce(db, vs, s.userId, s.connectionId, 'gmail_send_email', gmailInput({ to, subject, body, fromName: 'DealSaathi' }))
      const read = ran.outcome === 'answered' ? readGmailResult(ran.result) : { ok: false, unknown: ran.outcome === 'unknown', reason: ran.reason }
      const status = read.ok ? 'sent' : read.unknown ? 'unknown' : 'failed'
      finishExternal(db, claim, status, read.ok ? `Gmail message id ${read.messageId}` : read.reason)
      return read.ok ? { status, messageId: read.messageId } : { status, reason: read.reason }
    }
  }
}

import { audit, nowIso } from '../db.js'
import { messageDraftSchema, parseOrThrow } from '../validation.js'
import { HttpError } from './leads.js'
import { formatInr } from './properties.js'

const formatDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

/**
 * A rent reminder written only from the stored record. It never states that a payment was missed:
 * an overdue record says the stored status shows it unpaid and invites the tenant to reply if they have paid.
 */
export function rentReminderDraft(record, senderName) {
  const amount = formatInr(record.amount)
  const due = formatDate(record.due_date)
  const overdue = record.bucket === 'overdue'
  const subject = overdue ? `Rent for ${record.property_label}: payment due since ${due}` : `Rent reminder for ${record.property_label}: due ${due}`
  const lines = [
    `Dear ${record.tenant_name},`,
    '',
    overdue
      ? `Our records show the rent of ${amount} for ${record.property_label}, due on ${due}, as not yet received.`
      : `This is a friendly reminder that the rent of ${amount} for ${record.property_label} is due on ${due}.`,
    record.payment_status === 'partial' && record.last_payment_amount
      ? `We have recorded a part payment of ${formatInr(record.last_payment_amount)}${record.last_payment_date ? ` on ${formatDate(record.last_payment_date)}` : ''}.`
      : null,
    overdue ? 'If you have already paid, please reply with the payment details so we can update our records.' : 'If you have already paid, please ignore this message.',
    '',
    'Thank you,',
    senderName
  ]
  return { subject, body: lines.filter((line) => line !== null).join('\n') }
}

export function createMessageService(db, { leads, rent, integrations }) {
  const byId = db.prepare('SELECT * FROM messages WHERE id = ? AND owner_id = ?')

  return {
    get(ownerId, id) {
      const row = byId.get(id, ownerId)
      if (!row) throw new HttpError(404, 'Message not found.')
      return row
    },

    list(ownerId, { leadId, rentId, limit = 50 } = {}) {
      const where = ['owner_id = ?']
      const params = [ownerId]
      if (leadId) {
        where.push('lead_id = ?')
        params.push(leadId)
      }
      if (rentId) {
        where.push('rent_id = ?')
        params.push(rentId)
      }
      params.push(Math.min(Number(limit) || 50, 200))
      return db.prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...params)
    },

    createDraft(ownerId, { kind, leadId = null, rentId = null, subject, body, generatedBy = 'manual' }) {
      const draft = parseOrThrow(messageDraftSchema, { subject, body })
      let recipient = null
      if (kind === 'lead_followup') recipient = leads.get(ownerId, leadId).email
      else if (kind === 'rent_reminder') recipient = rent.get(ownerId, rentId).tenant_email
      else throw new HttpError(400, 'Unknown message kind.')
      const info = db
        .prepare(
          `INSERT INTO messages (owner_id, kind, lead_id, rent_id, recipient, subject, body, generated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ownerId, kind, leadId, rentId, recipient, draft.subject, draft.body, generatedBy)
      if (kind === 'rent_reminder') rent.setReminderStatus(ownerId, rentId, 'drafted')
      return this.get(ownerId, info.lastInsertRowid)
    },

    draftRentReminder(ownerId, rentId, senderName) {
      const record = rent.get(ownerId, rentId)
      if (record.bucket === 'paid') throw new HttpError(409, 'This rent is recorded as paid; no reminder is needed.')
      return this.createDraft(ownerId, { kind: 'rent_reminder', rentId, ...rentReminderDraft(record, senderName), generatedBy: 'template' })
    },

    updateDraft(ownerId, id, input) {
      const message = this.get(ownerId, id)
      if (!['draft', 'failed'].includes(message.status)) throw new HttpError(409, 'Only unsent drafts can be edited.')
      const draft = parseOrThrow(messageDraftSchema, { subject: input.subject ?? message.subject, body: input.body ?? message.body })
      db.prepare('UPDATE messages SET subject = ?, body = ?, updated_at = ? WHERE id = ?').run(draft.subject, draft.body, nowIso(), id)
      return this.get(ownerId, id)
    },

    /**
     * Sends a draft through the user's Gmail. The draft is claimed (draft|failed → sending) before the call, so a
     * double click or a retried request cannot send it twice. "sent" requires Gmail to return a message id.
     */
    async send(ownerId, id) {
      const message = this.get(ownerId, id)
      if (!message.recipient) throw new HttpError(422, 'This contact has no email address on record.')
      if (!integrations.gmailReady(ownerId)) {
        throw new HttpError(409, 'Sending is not configured: connect Gmail in Integrations. The draft is saved.', { code: 'not_connected' })
      }
      const claim = db
        .prepare(`UPDATE messages SET status = 'sending', error = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND status IN ('draft','failed')`)
        .run(nowIso(), id, ownerId)
      if (!claim.changes) throw new HttpError(409, `This message is already ${message.status}.`)
      try {
        const result = await integrations.sendEmail(ownerId, { to: message.recipient, subject: message.subject, body: message.body })
        const status = result.confirmed ? 'sent' : 'unconfirmed'
        db.prepare('UPDATE messages SET status = ?, provider_message_id = ?, sent_at = ?, updated_at = ? WHERE id = ?').run(
          status, result.messageId, nowIso(), nowIso(), id
        )
        if (message.kind === 'rent_reminder') rent.setReminderStatus(ownerId, message.rent_id, 'sent')
        if (message.kind === 'lead_followup' && result.confirmed) {
          const lead = leads.get(ownerId, message.lead_id)
          if (lead.status === 'new') leads.update(ownerId, lead.id, { status: 'contacted' })
        }
        audit(db, ownerId, 'message_sent', { message_id: id, status })
        return this.get(ownerId, id)
      } catch (error) {
        db.prepare(`UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(String(error.message).slice(0, 500), nowIso(), id)
        if (message.kind === 'rent_reminder') rent.setReminderStatus(ownerId, message.rent_id, 'failed')
        audit(db, ownerId, 'message_failed', { message_id: id, code: error.code })
        throw error
      }
    }
  }
}

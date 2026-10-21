import { audit, nowIso } from '../db.js'
import { parseOrThrow, viewingSchema } from '../validation.js'
import { HttpError } from './leads.js'
import { todayIn } from './rent.js'

export function createViewingService(db, { leads, properties, integrations, timeZone }) {
  const byId = db.prepare(
    `SELECT viewings.*, leads.full_name AS lead_name, leads.email AS lead_email, properties.title AS property_title,
            properties.is_sample AS property_is_sample
       FROM viewings JOIN leads ON leads.id = viewings.lead_id
       LEFT JOIN properties ON properties.id = viewings.property_id
      WHERE viewings.id = ? AND viewings.owner_id = ?`
  )
  const hydrate = (row) => row && { ...row, availability: row.availability ? JSON.parse(row.availability) : null, property_is_sample: Boolean(row.property_is_sample) }

  function validate(ownerId, input) {
    const viewing = parseOrThrow(viewingSchema, input)
    const lead = leads.get(ownerId, viewing.lead_id)
    const property = viewing.property_id ? properties.get(ownerId, viewing.property_id) : null
    if (viewing.start_date < todayIn(viewing.time_zone)) {
      throw new HttpError(422, 'The viewing date is in the past.', { issues: [{ field: 'start_date', message: 'is in the past' }] })
    }
    return {
      viewing: {
        ...viewing,
        location: viewing.location || property?.address || [property?.locality, property?.city].filter(Boolean).join(', ') || null
      },
      lead,
      property
    }
  }

  return {
    validate,

    list(ownerId, { upcomingOnly = false } = {}) {
      const today = todayIn(timeZone)
      return db
        .prepare(
          `SELECT viewings.*, leads.full_name AS lead_name, properties.title AS property_title, properties.is_sample AS property_is_sample
             FROM viewings JOIN leads ON leads.id = viewings.lead_id
             LEFT JOIN properties ON properties.id = viewings.property_id
            WHERE viewings.owner_id = ? ${upcomingOnly ? "AND viewings.start_date >= ? AND viewings.status NOT IN ('cancelled','completed')" : ''}
            ORDER BY viewings.start_date ASC, viewings.start_time ASC`
        )
        .all(...(upcomingOnly ? [ownerId, today] : [ownerId]))
        .map(hydrate)
    },

    get(ownerId, id) {
      const row = hydrate(byId.get(id, ownerId))
      if (!row) throw new HttpError(404, 'Viewing not found.')
      return row
    },

    /** Saves an unbooked proposal. Nothing is sent to a calendar here. */
    propose(ownerId, input) {
      const { viewing, property } = validate(ownerId, input)
      const info = db
        .prepare(
          `INSERT INTO viewings (owner_id, lead_id, property_id, property_label, start_date, start_time, duration_minutes,
             time_zone, broker, location, notes, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`
        )
        .run(ownerId, viewing.lead_id, viewing.property_id, viewing.property_label || property?.title || null, viewing.start_date,
          viewing.start_time, viewing.duration_minutes, viewing.time_zone, viewing.broker, viewing.location, viewing.notes)
      audit(db, ownerId, 'viewing_proposed', { viewing_id: info.lastInsertRowid })
      return this.get(ownerId, info.lastInsertRowid)
    },

    async checkAvailability(ownerId, id) {
      const viewing = this.get(ownerId, id)
      const availability = await integrations.checkAvailability(ownerId, viewing)
      db.prepare('UPDATE viewings SET availability = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(JSON.stringify(availability), nowIso(), id, ownerId)
      return this.get(ownerId, id)
    },

    /**
     * Books the proposal on Google Calendar. Only a response carrying an event id counts as booked; any other
     * answer is stored as booking_unverified with the raw response, and an error as booking_failed.
     */
    async book(ownerId, id) {
      const viewing = this.get(ownerId, id)
      if (viewing.status === 'booked') throw new HttpError(409, 'This viewing is already booked.')
      if (!['proposed', 'booking_failed', 'booking_unverified'].includes(viewing.status)) {
        throw new HttpError(409, `A ${viewing.status} viewing cannot be booked.`)
      }
      const lead = leads.get(ownerId, viewing.lead_id)
      // Claim the row first: a second confirm arriving while this one runs finds status 'booking' and stops.
      const claimed = db
        .prepare(`UPDATE viewings SET status = 'booking', updated_at = ? WHERE id = ? AND owner_id = ? AND status = ?`)
        .run(nowIso(), id, ownerId, viewing.status)
      if (!claimed.changes) throw new HttpError(409, 'This viewing is already being booked. Refresh in a moment.')
      try {
        const result = await integrations.createEvent(ownerId, {
          viewing,
          lead,
          propertyTitle: viewing.property_title || viewing.property_label || 'Property'
        })
        const status = result.confirmed ? 'booked' : 'booking_unverified'
        db.prepare('UPDATE viewings SET status = ?, calendar_event_id = ?, calendar_response = ?, updated_at = ? WHERE id = ?').run(
          status, result.eventId, JSON.stringify(result.response).slice(0, 4000), nowIso(), id
        )
        if (result.confirmed && ['new', 'contacted', 'interested'].includes(lead.status)) {
          leads.update(ownerId, lead.id, { status: 'viewing_scheduled' })
        }
        audit(db, ownerId, 'viewing_booking', { viewing_id: id, status })
        return { viewing: this.get(ownerId, id), confirmed: result.confirmed, htmlLink: result.htmlLink }
      } catch (error) {
        db.prepare(`UPDATE viewings SET status = 'booking_failed', calendar_response = ?, updated_at = ? WHERE id = ?`).run(
          JSON.stringify({ error: error.message }), nowIso(), id
        )
        audit(db, ownerId, 'viewing_booking_failed', { viewing_id: id, error: error.message })
        throw error
      }
    },

    setStatus(ownerId, id, status) {
      if (!['cancelled', 'completed'].includes(status)) throw new HttpError(422, 'Status can only be set to cancelled or completed here.')
      this.get(ownerId, id)
      db.prepare('UPDATE viewings SET status = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(status, nowIso(), id, ownerId)
      return this.get(ownerId, id)
    }
  }
}

import { audit, nowIso } from '../db.js'
import { APPS, APP_BY_SERVICE, ViaSocketError } from '../viasocket.js'
import { HttpError } from './leads.js'

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Plain text from the editor → the HTML Gmail's Send Email `messageBody` renders. */
export function textToHtml(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function connectionList(data) {
  if (Array.isArray(data)) return data
  for (const key of ['authentications', 'data', 'connections']) if (Array.isArray(data?.[key])) return data[key]
  return []
}

/** Offset (minutes) of a time zone from UTC at a given instant, from Intl alone. */
function zoneOffsetMinutes(timeZone, instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(instant).map((p) => [p.type, p.value])
  )
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return Math.round((asUtc - instant.getTime()) / 60_000)
}

/** The UTC instant of a local date and HH:MM in a time zone. */
export function zonedToUtc(date, time, timeZone) {
  const naive = new Date(`${date}T${time}:00Z`)
  const offset = zoneOffsetMinutes(timeZone, naive)
  const guess = new Date(naive.getTime() - offset * 60_000)
  const corrected = zoneOffsetMinutes(timeZone, guess)
  return new Date(naive.getTime() - corrected * 60_000)
}

/**
 * Reads busy intervals from a Get Free/Busy Information response ({ calendars: { <id>: { busy: [...] } } }).
 * Returns null when the response does not have that shape, so the caller reports "could not determine".
 */
export function parseBusy(response) {
  const calendars = response?.calendars
  if (!calendars || typeof calendars !== 'object') return null
  const busy = []
  for (const calendar of Object.values(calendars)) {
    if (calendar?.errors?.length) return null
    for (const slot of calendar?.busy || []) {
      const start = new Date(slot.start)
      const end = new Date(slot.end)
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) busy.push({ start, end })
    }
  }
  return busy
}

const pad = (n) => String(n).padStart(2, '0')

export function createIntegrationService(db, viasocket) {
  const getRow = db.prepare('SELECT * FROM integrations WHERE owner_id = ? AND service_id = ?')

  function record(ownerId, app) {
    const row = getRow.get(ownerId, app.serviceId)
    return row && { ...row, settings: JSON.parse(row.settings || '{}') }
  }

  function requireApp(ownerId, app) {
    if (!viasocket.configured) {
      throw new HttpError(503, `${app.name} is not available: viaSocket is not configured on the server.`, { code: 'not_configured' })
    }
    const row = record(ownerId, app)
    if (!row?.script_id) throw new HttpError(409, `Connect ${app.name} in Integrations first.`, { code: 'not_connected' })
    return row
  }

  function saveSettings(ownerId, app, settings) {
    db.prepare('UPDATE integrations SET settings = ?, updated_at = ? WHERE owner_id = ? AND service_id = ?').run(
      JSON.stringify(settings), nowIso(), ownerId, app.serviceId
    )
  }

  return {
    record,

    async status(ownerId) {
      const apps = Object.values(APPS).map((app) => {
        const row = record(ownerId, app)
        return {
          key: app.key, name: app.name, serviceId: app.serviceId, icon: app.icon, purpose: app.purpose,
          actionIds: app.actionIds, stored: Boolean(row?.script_id), settings: row?.settings || {}
        }
      })
      if (!viasocket.configured) return { configured: false, verified: false, apps }
      try {
        const live = connectionList(await viasocket.listConnections(ownerId))
        for (const app of apps) {
          const row = record(ownerId, APPS[app.key])
          const conn = row && live.find((c) => c.id === row.auth_id)
          app.connected = Boolean(conn && app.stored)
          app.expired = Boolean(conn?.isExpired)
          app.liveAuthId = conn ? row.auth_id : null
          if (row && !conn) app.problem = 'The stored connection no longer exists in viaSocket. Connect again.'
        }
        return { configured: true, verified: true, apps }
      } catch (error) {
        return { configured: true, verified: false, error: error.message, apps }
      }
    },

    /** Called after the Connect popup reports success. The auth_id is checked against viaSocket, never trusted as sent. */
    async connect(ownerId, serviceId, authId) {
      const app = APP_BY_SERVICE[serviceId]
      if (!app) throw new HttpError(400, 'DealSaathi does not use this app.')
      if (typeof authId !== 'string' || !/^[A-Za-z0-9_-]{4,100}$/.test(authId)) throw new HttpError(400, 'Invalid connection id.')
      if (!viasocket.configured) throw new HttpError(503, 'viaSocket is not configured on the server.', { code: 'not_configured' })
      const live = connectionList(await viasocket.listConnections(ownerId))
      if (!live.some((c) => c.id === authId)) throw new HttpError(400, 'That connection was not found for your account in viaSocket.')
      const scriptId = (await viasocket.findEnabledApp(ownerId, serviceId)) || (await viasocket.enableApp(ownerId, serviceId, authId))
      db.prepare(
        `INSERT INTO integrations (owner_id, service_id, auth_id, script_id) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id, service_id) DO UPDATE SET auth_id = excluded.auth_id, script_id = excluded.script_id, updated_at = excluded.created_at`
      ).run(ownerId, serviceId, authId, scriptId)
      audit(db, ownerId, 'integration_connected', { service_id: serviceId })
      return { connected: true, app: app.name }
    },

    disconnectLocal(ownerId, serviceId) {
      db.prepare('DELETE FROM integrations WHERE owner_id = ? AND service_id = ?').run(ownerId, serviceId)
      audit(db, ownerId, 'integration_forgotten', { service_id: serviceId })
    },

    gmailReady(ownerId) {
      return viasocket.configured && Boolean(record(ownerId, APPS.gmail)?.script_id)
    },

    calendarReady(ownerId) {
      const row = record(ownerId, APPS.googleCalendar)
      return viasocket.configured && Boolean(row?.script_id && row.settings.calendar_id)
    },

    /**
     * Gmail → Send Email (rowwj0sfmhub). Only `to`, `subject` and `messageBody` are sent: cc, bcc, replyTo,
     * fromName, attachments and labelIds are optional and a one-to-one follow-up needs none of them; `from`
     * is left out so Gmail uses the connected account's own address.
     */
    async sendEmail(ownerId, { to, subject, body }) {
      const row = requireApp(ownerId, APPS.gmail)
      const response = await viasocket.runAction(row.script_id, APPS.gmail.sendEmail.actionVersionId, {
        to, subject, messageBody: textToHtml(body)
      })
      const id = response?.id || response?.data?.id || response?.messageId
      return { confirmed: Boolean(id), messageId: id || null, response }
    },

    async listCalendars(ownerId) {
      const row = requireApp(ownerId, APPS.googleCalendar)
      return viasocket.listOptions(ownerId, APPS.googleCalendar.createEvent.actionVersionId, 'calendar_id', {}, row.auth_id)
    },

    chooseCalendar(ownerId, { calendar_id, label }) {
      const row = requireApp(ownerId, APPS.googleCalendar)
      if (typeof calendar_id !== 'string' || !calendar_id) throw new HttpError(422, 'Choose a calendar.')
      saveSettings(ownerId, APPS.googleCalendar, { ...row.settings, calendar_id, calendar_label: String(label || calendar_id).slice(0, 200) })
    },

    /** Google Calendar → Get Free/Busy Information (row0ce18xwwk) for the viewing's day, then an overlap check. */
    async checkAvailability(ownerId, viewing) {
      const row = requireApp(ownerId, APPS.googleCalendar)
      if (!row.settings.calendar_id) throw new HttpError(409, 'Choose which calendar to use in Integrations first.', { code: 'no_calendar' })
      const response = await viasocket.runAction(row.script_id, APPS.googleCalendar.freeBusy.actionVersionId, {
        calendar_id: row.settings.calendar_id,
        date: viewing.start_date,
        timeZone: viewing.time_zone
      })
      const busy = parseBusy(response)
      const checkedAt = nowIso()
      if (!busy) return { checked: false, checked_at: checkedAt, message: 'Google Calendar answered, but not with free/busy data, so availability is unknown.' }
      const start = zonedToUtc(viewing.start_date, viewing.start_time, viewing.time_zone)
      const end = new Date(start.getTime() + viewing.duration_minutes * 60_000)
      const conflicts = busy.filter((slot) => slot.start < end && slot.end > start)
      return {
        checked: true,
        checked_at: checkedAt,
        free: conflicts.length === 0,
        conflicts: conflicts.map((c) => ({ start: c.start.toISOString(), end: c.end.toISOString() })),
        message: conflicts.length ? `The calendar has ${conflicts.length} busy slot(s) overlapping this time.` : 'The calendar is free at this time.'
      }
    },

    /**
     * Google Calendar → Create Calendar Event (rown3bkuc5jc). Fixed in code: status "confirmed" (it is a booking),
     * colorId "4" (the action's default), no recurrence (a viewing is one visit), useDefault true and visibility
     * "default" (the calendar's own settings), transparency "opaque" (the broker is busy during a visit) and
     * guestsCanModify false (the broker owns the slot).
     */
    async createEvent(ownerId, { viewing, lead, propertyTitle }) {
      const row = requireApp(ownerId, APPS.googleCalendar)
      if (!row.settings.calendar_id) throw new HttpError(409, 'Choose which calendar to use in Integrations first.', { code: 'no_calendar' })
      if (!lead.email) throw new HttpError(422, 'Google Calendar needs an attendee email: add an email address to this lead first.')
      const [y, m, d] = viewing.start_date.split('-')
      const duration = `${pad(Math.floor(viewing.duration_minutes / 60))}:${pad(viewing.duration_minutes % 60)}`
      const response = await viasocket.runAction(row.script_id, APPS.googleCalendar.createEvent.actionVersionId, {
        calendar_id: row.settings.calendar_id,
        summary: `Property viewing: ${propertyTitle} with ${lead.full_name}`,
        description: [`Property viewing arranged through DealSaathi.`, viewing.broker && `Broker: ${viewing.broker}`, viewing.notes]
          .filter(Boolean)
          .join('\n'),
        attendees: lead.email,
        timeZone: viewing.time_zone,
        starttime: viewing.start_time,
        startdate: `${d}-${m}-${y}`,
        meeting_duration: duration,
        location: viewing.location || propertyTitle,
        status: 'confirmed',
        colorId: '4',
        useDefault: true,
        visibility: 'default',
        transparency: 'opaque',
        guestsCanModify: false
      })
      const eventId = response?.id || response?.data?.id || null
      return { confirmed: Boolean(eventId), eventId, htmlLink: response?.htmlLink || response?.data?.htmlLink || null, response }
    }
  }
}

export { ViaSocketError }

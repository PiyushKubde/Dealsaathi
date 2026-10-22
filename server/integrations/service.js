// A user's connected apps: https://flow.viasocket.com/documentation/skill/connect.md and .../skill/manage.md
// auth_id and script_id never leave the server; the browser sees a connection by its row id.
import { now, transaction } from '../db.js'
import { AppError } from '../errors.js'

const SERVICE_ID_RE = /^[A-Za-z0-9]{3,40}$/
const AUTH_ID_RE = /^[A-Za-z0-9_]{3,100}$/

export function checkServiceId(serviceId) {
  if (typeof serviceId !== 'string' || !SERVICE_ID_RE.test(serviceId)) throw new AppError(400, 'validation_failed', 'Not a valid app id.')
  return serviceId
}

export function requireViasocket(vs) {
  if (!vs.configured) throw new AppError(503, 'viasocket_not_configured', 'viaSocket is not configured: add VIASOCKET_ORG_ID, VIASOCKET_PROJECT_ID and VIASOCKET_EMBED_SECRET and restart.')
}

/** viaSocket's own reason, without anything that could carry a credential (run URLs, script ids, tokens). */
export function cleanViasocketMessage(error) {
  const raw = typeof error?.message === 'string' ? error.message : 'viaSocket did not accept the request.'
  return raw
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\bscri[A-Za-z0-9]{6,}\b/g, '[id]')
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, '[token]')
    .slice(0, 300)
}

/** Turns a failed viaSocket call into an answer the broker can act on. */
export function viasocketError(error, what) {
  if (error instanceof AppError) return error
  const status = error?.status
  if (status === 401 || status === 403) return new AppError(502, 'viasocket_auth', `viaSocket refused ${what}: this app's viaSocket credentials were not accepted.`)
  if (status === null || status === undefined) return new AppError(504, 'viasocket_unreachable', `Could not reach viaSocket to ${what}. Try again in a moment.`)
  return new AppError(502, 'viasocket_error', `viaSocket could not ${what}: ${cleanViasocketMessage(error)}`)
}

const safeJson = (s) => {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

/** "{\"Email\":\"a@b.com\"}" → "a@b.com": the account name viaSocket shows for a connection. */
function labelOf(connection) {
  const raw = connection?.connection_label
  const parsed = typeof raw === 'string' ? safeJson(raw) : raw
  if (parsed && typeof parsed === 'object') return Object.values(parsed).filter((v) => typeof v === 'string').join(', ').slice(0, 120) || null
  return typeof raw === 'string' ? raw.slice(0, 120) : null
}

function toPublic(row, live) {
  return {
    id: row.id,
    serviceId: row.service_id,
    appName: row.app_name,
    iconUrl: row.icon_url,
    label: row.label,
    status: live === undefined ? 'unknown' : !live ? 'missing' : live.isExpired ? 'expired' : 'active',
    verification: row.verified_at ? { status: row.verify_status, detail: row.verify_detail, at: row.verified_at } : null,
    createdAt: row.created_at
  }
}

/** The user's connections, each with its live status from viaSocket (active, expired, missing). */
export async function listUserConnections(db, vs, userId) {
  const rows = db.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at DESC').all(userId)
  if (!rows.length || !vs.configured) return { connections: rows.map((r) => toPublic(r)), live: false }
  try {
    const live = await vs.listConnections(userId)
    const byId = new Map(live.map((c) => [c.id, c]))
    return { connections: rows.map((r) => toPublic(r, byId.get(r.auth_id) || null)), live: true }
  } catch (error) {
    return { connections: rows.map((r) => toPublic(r)), live: false, error: viasocketError(error, 'read your connections').message }
  }
}

/** The stored row for one of the user's connections; another user's id answers 404. */
export function requireOwnConnection(db, userId, id) {
  const row = db.prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?').get(Number(id), userId)
  if (!row) throw new AppError(404, 'connection_not_found', 'No such connection.')
  return row
}

/**
 * Saves a connection the Connect popup produced. The auth_id comes from the browser, so it is
 * checked against this user's own connections on viaSocket before anything is stored.
 */
export async function saveConnection(db, vs, userId, { serviceId, authId }) {
  requireViasocket(vs)
  checkServiceId(serviceId)
  if (typeof authId !== 'string' || !AUTH_ID_RE.test(authId)) throw new AppError(400, 'validation_failed', 'Not a valid connection id.')

  let live
  try {
    live = await vs.listConnections(userId)
  } catch (error) {
    throw viasocketError(error, 'check the new connection')
  }
  const match = live.find((c) => c.id === authId)
  if (!match) throw new AppError(403, 'connection_not_yours', 'viaSocket has no such connection for your account, so it was not saved.')
  if (match.service_id && match.service_id !== serviceId) throw new AppError(400, 'connection_app_mismatch', 'That connection belongs to a different app.')

  const ts = now()
  const appName = String(match.service_name || serviceId).slice(0, 80)
  const icon = typeof match.iconUrl === 'string' ? match.iconUrl.slice(0, 500) : null
  db.prepare(`INSERT INTO connections (user_id, service_id, app_name, icon_url, auth_id, label, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (user_id, auth_id) DO UPDATE SET app_name = excluded.app_name, icon_url = excluded.icon_url, label = excluded.label, updated_at = excluded.updated_at`)
    .run(userId, serviceId, appName, icon, authId, labelOf(match), ts, ts)
  const row = db.prepare('SELECT * FROM connections WHERE user_id = ? AND auth_id = ?').get(userId, authId)
  return toPublic(row, match)
}

/** What the browser needs to reconnect an expired connection in place (connect() with authId). */
export async function reconnectDetails(db, vs, userId, id) {
  requireViasocket(vs)
  const row = requireOwnConnection(db, userId, id)
  return { embedToken: await vs.token(userId), serviceId: row.service_id, authId: row.auth_id }
}

/**
 * Disconnects: pauses the app flows DealSaathi enabled on this connection, then revokes it on
 * viaSocket, then forgets it. A connection already gone from viaSocket is just forgotten.
 */
export async function disconnect(db, vs, userId, id) {
  requireViasocket(vs)
  const row = requireOwnConnection(db, userId, id)
  let live
  try {
    live = await vs.listConnections(userId)
  } catch (error) {
    throw viasocketError(error, 'disconnect this account')
  }
  const stillThere = live.some((c) => c.id === row.auth_id)
  if (stillThere) {
    const enabled = db.prepare('SELECT script_id FROM enabled_apps WHERE user_id = ? AND auth_id = ?').all(userId, row.auth_id)
    try {
      for (const { script_id } of enabled) await vs.setFlowStatus(userId, script_id, 2)
      await vs.revokeConnection(userId, row.auth_id)
    } catch (error) {
      throw viasocketError(error, 'disconnect this account')
    }
  }
  transaction(db, () => {
    db.prepare('DELETE FROM enabled_apps WHERE user_id = ? AND auth_id = ?').run(userId, row.auth_id)
    db.prepare('DELETE FROM connections WHERE id = ?').run(row.id)
  })
  return { disconnected: true, revokedOnViasocket: stillThere }
}

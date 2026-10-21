// A user's flows: those they build in viaSocket's prebuilt UI (https://flow.viasocket.com/documentation/embed.md)
// and the enabled apps DealSaathi runs actions through. A flow's id is its script_id, which runs it, so the
// browser gets an opaque ref instead and every change goes through the server.
import { createHash } from 'node:crypto'
import { now } from '../db.js'
import { AppError } from '../errors.js'
import { requireViasocket, viasocketError } from '../integrations/service.js'

const FLOW_EVENTS = ['initiated', 'published', 'updated', 'paused', 'deleted']
const FLOW_ID_RE = /^[A-Za-z0-9]{6,40}$/

export const flowRef = (userId, flowId) => createHash('sha256').update(`${userId}:${flowId}`).digest('hex').slice(0, 20)

async function liveFlows(vs, userId, what) {
  requireViasocket(vs)
  try {
    return await vs.listFlows(userId)
  } catch (error) {
    throw viasocketError(error, what)
  }
}

export async function listAutomationFlows(db, vs, userId) {
  const flows = await liveFlows(vs, userId, 'list your automations')
  const enabled = new Set(db.prepare('SELECT script_id FROM enabled_apps WHERE user_id = ?').all(userId).map((r) => r.script_id))
  return flows
    .filter((f) => f.status !== 'deleted')
    .map((f) => ({
      ref: flowRef(userId, f.id),
      title: enabled.has(f.id) ? 'Gmail sending for DealSaathi follow-ups' : f.title || 'Untitled automation',
      description: enabled.has(f.id) ? 'Enabled by DealSaathi so follow-up emails can be sent from your Gmail.' : (f.description || '').slice(0, 300),
      status: f.status,
      kind: enabled.has(f.id) ? 'dealsaathi' : 'workflow'
    }))
}

/** Pauses or resumes one of the user's own flows. */
export async function setAutomationStatus(db, vs, userId, ref, status) {
  if (!['active', 'paused'].includes(status)) throw new AppError(400, 'validation_failed', 'Status must be active or paused.')
  const flows = await liveFlows(vs, userId, 'change this automation')
  const flow = flows.find((f) => flowRef(userId, f.id) === ref && f.status !== 'deleted')
  if (!flow) throw new AppError(404, 'flow_not_found', 'No such automation.')
  try {
    await vs.setFlowStatus(userId, flow.id, status === 'active' ? 1 : 2)
  } catch (error) {
    throw viasocketError(error, 'change this automation')
  }
  return { ref, status }
}

/**
 * A flow event the prebuilt UI posted to the page. The browser's copy is not trusted: the flow must be
 * in this user's own flow list, and its title and status are read from there.
 */
export async function recordFlowEvent(db, vs, userId, { flowId, action }) {
  if (typeof flowId !== 'string' || !FLOW_ID_RE.test(flowId)) throw new AppError(400, 'validation_failed', 'Not a valid flow id.')
  if (!FLOW_EVENTS.includes(action)) throw new AppError(400, 'validation_failed', 'Unknown flow event.')
  const flows = await liveFlows(vs, userId, 'check this automation')
  const flow = flows.find((f) => f.id === flowId)
  if (!flow) throw new AppError(404, 'flow_not_found', 'viaSocket has no such flow for your account.')
  db.prepare(`INSERT INTO automation_flows (user_id, flow_id, title, status, last_event, updated_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (user_id, flow_id) DO UPDATE SET title = excluded.title, status = excluded.status, last_event = excluded.last_event, updated_at = excluded.updated_at`)
    .run(userId, flowId, String(flow.title || '').slice(0, 200), flow.status, action, now())
  return { recorded: true, ref: flowRef(userId, flowId), title: flow.title || 'Untitled automation', status: flow.status, event: action }
}

/** Recent automation events DealSaathi has seen for this user. */
export function recentFlowEvents(db, userId) {
  return db.prepare('SELECT flow_id, title, status, last_event, updated_at FROM automation_flows WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20').all(userId)
    .map((r) => ({ ref: flowRef(userId, r.flow_id), title: r.title || 'Untitled automation', status: r.status, event: r.last_event, at: r.updated_at }))
}

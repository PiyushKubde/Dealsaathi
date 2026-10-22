// The agent runtime: one bounded loop per user message. Each step asks the model (viaSocket AI, structured JSON)
// for one decision; this code validates it and runs the chosen tool as the signed-in user. The loop ends when the
// model asks or answers, when an action needs the user's approval, or at a limit. Nothing here sends a message,
// takes a payment or books a calendar slot.
import { randomUUID } from 'node:crypto'
import { now, transaction } from '../db.js'
import { AppError } from '../errors.js'
import { canViewProperty, requireRole } from '../access.js'
import { getProperty } from '../properties/service.js'
import { requestViewing } from '../viewings/service.js'
import { describeInZone, todayIn } from '../time.js'
import { parseRequest } from './parse.js'
import { DECISION_SCHEMA, systemPrompt } from './prompt.js'
import { TOOLS, ToolInputError, toolError, toolsFor } from './tools.js'

export const LIMITS = { decisions: 6, toolCalls: 4, errors: 2, aiTimeoutMs: 30000, toolTimeoutMs: 20000, turnMs: 60000, message: 1000, reply: 1500 }
const RATE = { max: 20, windowMs: 10 * 60 * 1000 }
const parse = (s) => (s ? JSON.parse(s) : null)
const recent = new Map() // userId → message times, for the per-user rate limit

// A reply may not claim what only the agent's confirmation does: a sentence stating a booking as done. Sentences
// that explain the condition ("booked only after your agent confirms", "not booked yet") are fine.
const CLAIM = /\b(booked|scheduled|confirmed|(?:added|put) (?:it )?(?:to|in(?:to)?) (?:your|the|their) calendar|calendar invite)\b/i
const CONDITION = /\b(only|after|once|when|until|unless|if|not|never|yet|will|would|can|could|before|pending|waiting)\b|n't\b/i
export const claimsBooking = (text) => String(text).split(/(?<=[.!?])\s+|\n+/).some((sentence) => CLAIM.test(sentence) && !CONDITION.test(sentence))

function withTimeout(promise, ms, code) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms) })]).finally(() => clearTimeout(timer))
}

function rateLimit(userId) {
  const t = Date.now()
  const list = (recent.get(userId) || []).filter((x) => t - x < RATE.windowMs)
  if (list.length >= RATE.max) throw new AppError(429, 'agent_rate_limited', 'Too many messages in a short time. Wait a few minutes and try again.')
  list.push(t)
  recent.set(userId, list)
}

function ownConversation(db, id, userId) {
  const c = typeof id === 'string' ? db.prepare('SELECT * FROM agent_conversations WHERE id = ? AND user_id = ?').get(id, userId) : null
  if (!c) throw new AppError(404, 'conversation_not_found', 'No such conversation.')
  return c
}

function addMessage(db, conversationId, role, content, payload = null) {
  db.prepare('INSERT INTO agent_messages (conversation_id, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(conversationId, role, content, payload ? JSON.stringify(payload) : null, now())
}

/** An approval card: what will happen if the user confirms, and what has happened. */
function describeAction(db, row) {
  const params = parse(row.params)
  return {
    id: row.id, type: row.type, status: row.status, expiresAt: row.expires_at,
    properties: params.propertyIds.map((id) => ({ id, title: getProperty(db, id)?.title ?? '(listing removed)' })),
    start: params.start, when: params.timezone ? describeInZone(params.start, params.timezone) : params.start, result: parse(row.result), error: row.error
  }
}

/** Cards from earlier turns are shown (or offered to the model) again only while the listing is still visible. */
const stillVisible = (db, user, cards) => (cards || []).filter((c) => canViewProperty(user, getProperty(db, c.id)))

function expireActions(db, userId) {
  db.prepare("UPDATE agent_actions SET status = 'expired', updated_at = ? WHERE user_id = ? AND status = 'awaiting_confirmation' AND expires_at < ?").run(now(), userId, now())
}

/** The JSON the model reads each step. Compact, the user's own data only, no contact details. */
function contextFor(db, ctx, turn) {
  const history = db.prepare('SELECT role, content FROM agent_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 9').all(ctx.conversationId).reverse().slice(0, -1)
  const pending = db.prepare("SELECT * FROM agent_actions WHERE conversation_id = ? AND status = 'awaiting_confirmation' ORDER BY created_at DESC LIMIT 1").get(ctx.conversationId)
  return JSON.stringify({
    today: todayIn('Asia/Kolkata'), timezone: 'Asia/Kolkata', helping: 'a buyer',
    conversation: history.map((m) => ({ role: m.role, text: m.content.slice(0, 600) })),
    listings_shown_earlier: stillVisible(db, ctx.user, ctx.state.shown).slice(0, 10),
    free_times_shown_earlier: (ctx.state.offers || []).map((o) => ({ property_id: o.property_id, title: o.title, date: o.date, timezone: o.timezone, agent_name: o.agent_name, free_times: o.slots.slice(0, 16) })),
    criteria_in_use: ctx.state.criteria || null,
    viewing_request_waiting_for_buyer_confirm: pending ? describeAction(db, pending) : null,
    this_turn: { buyer_message: turn.message, read_from_message: parseRequest(turn.message), steps: turn.observations },
    limits_left: { decisions: LIMITS.decisions - turn.decisions, tool_calls: LIMITS.toolCalls - turn.toolCalls }
  })
}

/** The model's answer → a decision, or a reason it is unusable. */
function readDecision(content, allowed) {
  let d = content
  if (typeof d === 'string') { try { d = JSON.parse(d) } catch { return { error: 'Your reply was not JSON.' } } }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { error: 'Your reply was not a JSON object.' }
  if (!['tool', 'ask', 'answer'].includes(d.type)) return { error: 'type must be tool, ask or answer.' }
  if (d.type === 'tool') {
    if (!allowed.includes(d.tool)) return { error: `Unknown tool "${String(d.tool).slice(0, 40)}". Use one of: ${allowed.join(', ')}.` }
    if (d.args !== null && d.args !== undefined && (typeof d.args !== 'object' || Array.isArray(d.args))) return { error: 'args must be an object.' }
    return { decision: { type: 'tool', tool: d.tool, args: d.args || {} } }
  }
  const message = typeof d.message === 'string' ? d.message.trim() : ''
  if (!message) return { error: 'message is required for ask and answer.' }
  if (claimsBooking(message)) return { error: 'Do not say a viewing is booked or in a calendar: only the agent\'s confirmation books it. Rephrase.' }
  const ids = Array.isArray(d.listing_ids) ? d.listing_ids.filter(Number.isInteger).slice(0, 10) : []
  return { decision: { type: d.type, message: message.slice(0, LIMITS.reply), listingIds: ids } }
}

/**
 * One buyer message through the loop. Returns what the page shows: the reply, the steps taken (in plain words),
 * listings and free times found, and an approval card when a viewing request is ready to confirm.
 */
export async function handleAgentMessage(db, ai, vs, user, { conversationId, message }) {
  requireRole(user, 'buyer')
  if (typeof message !== 'string' || !message.trim()) throw new AppError(400, 'validation_failed', 'Type a message first.')
  if (message.length > LIMITS.message) throw new AppError(400, 'validation_failed', `Messages must be ${LIMITS.message} characters or fewer.`)
  if (!ai?.configured) throw new AppError(503, 'ai_not_configured', 'The assistant is not available on this server right now. You can still browse listings and request viewings yourself.')
  rateLimit(user.id)

  let conv
  if (conversationId) conv = ownConversation(db, conversationId, user.id)
  else {
    const id = randomUUID()
    db.prepare('INSERT INTO agent_conversations (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, user.id, now(), now())
    conv = ownConversation(db, id, user.id)
  }
  // One turn at a time per conversation: a second message while one runs is refused, not interleaved.
  const locked = db.prepare('UPDATE agent_conversations SET busy_until = ? WHERE id = ? AND (busy_until IS NULL OR busy_until < ?)')
    .run(new Date(Date.now() + LIMITS.turnMs + 30000).toISOString(), conv.id, now()).changes
  if (!locked) throw new AppError(409, 'agent_busy', 'The assistant is still working on your last message.')

  const runId = randomUUID()
  const started = Date.now()
  const steps = []
  const turn = { message: message.trim(), observations: [], decisions: 0, toolCalls: 0, errors: 0 }
  const ctx = {
    db, vs, user, conversationId: conv.id, state: parse(conv.state) || {},
    // Newest first: the buyer's latest word on a requirement wins (tools.js stated()).
    userMessages: [message.trim(), ...db.prepare("SELECT content FROM agent_messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 10").all(conv.id).map((m) => m.content)],
    savedRequirements: null
  }
  const pr = db.prepare('SELECT b.lead_id FROM buyer_profiles b WHERE b.user_id = ?').get(user.id)
  if (pr?.lead_id) {
    const l = db.prepare('SELECT preferred_location, bedrooms, budget_min, budget_max, property_type, customer_type FROM leads WHERE id = ?').get(pr.lead_id)
    ctx.savedRequirements = l || null
  }
  try {
    expireActions(db, user.id)
    addMessage(db, conv.id, 'user', turn.message)
    db.prepare("INSERT INTO agent_runs (id, conversation_id, user_id, status, started_at) VALUES (?, ?, ?, 'running', ?)").run(runId, conv.id, user.id, now())
    const allowed = toolsFor(user.role)
    const prompt = systemPrompt(allowed)
    const seen = new Map() // listing id → card, from this turn's tools
    const calls = new Set()
    let offer = null
    let action = null
    const step = (row) => {
      db.prepare('INSERT INTO agent_steps (run_id, n, kind, tool, status, error_code, label, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(runId, steps.length + 1, row.kind, row.tool ?? null, row.status, row.code ?? null, row.label ?? null, row.ms ?? null, now())
      steps.push(row)
    }
    const finish = (status, reply, { stopReason = null, listingIds = [] } = {}) => {
      const earlier = stillVisible(db, user, ctx.state.shown)
      const listings = listingIds.map((id) => seen.get(id) || earlier.find((x) => x.id === id)).filter(Boolean)
      ctx.state.shown = [...seen.values(), ...earlier.filter((x) => !seen.has(x.id))].slice(0, 10)
      const payload = { status, steps: steps.filter((s) => s.kind === 'tool' && s.label).map((s) => ({ label: s.label, status: s.status })), listings, offer, actionId: action?.id ?? null }
      transaction(db, () => {
        addMessage(db, conv.id, 'assistant', reply, payload)
        db.prepare('UPDATE agent_runs SET status = ?, stop_reason = ?, decisions = ?, tool_calls = ?, finished_at = ? WHERE id = ?').run(status, stopReason, turn.decisions, turn.toolCalls, now(), runId)
        db.prepare('UPDATE agent_conversations SET state = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(ctx.state), now(), conv.id)
      })
      console.log(`[agent] run ${runId.slice(0, 8)} ${status}${stopReason ? ` (${stopReason})` : ''} decisions=${turn.decisions} tools=${steps.filter((s) => s.kind === 'tool').map((s) => `${s.tool}:${s.status}`).join(',') || '-'} ${Date.now() - started}ms`)
      return { conversationId: conv.id, runId, status, reply, steps: payload.steps, listings, offer, action: action ? describeAction(db, db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(action.id)) : null }
    }

    while (true) {
      if (turn.decisions >= LIMITS.decisions) return finish('stopped', 'I stopped here to stay within my step limit. Here is what I found so far; tell me how you would like to continue.', { stopReason: 'step_limit', listingIds: [...seen.keys()].slice(0, 5) })
      if (Date.now() - started > LIMITS.turnMs) return finish('stopped', 'This is taking too long, so I stopped. Please try again or ask a simpler question.', { stopReason: 'time_limit', listingIds: [...seen.keys()].slice(0, 5) })
      if (turn.errors >= LIMITS.errors) return finish('stopped', 'I could not complete that reliably, so I stopped without doing anything. Please rephrase, or use Browse listings and My viewings directly.', { stopReason: 'too_many_errors' })

      turn.decisions++
      // No wait may outlast the turn (the conversation lock is held for the turn plus a margin).
      const left = () => Math.max(1, LIMITS.turnMs - (Date.now() - started))
      const t0 = Date.now()
      let reply
      try {
        reply = await withTimeout(ai.send({ threadId: `ds-agent-${runId.slice(0, 13)}-${turn.decisions}`, message: contextFor(db, ctx, turn), prompt, responseType: 'json_schema', jsonSchema: DECISION_SCHEMA }, { userId: user.id }), Math.min(LIMITS.aiTimeoutMs, left()), 'ai_timeout')
      } catch (error) {
        step({ kind: 'decision', status: 'error', code: error.code === 'ai_timeout' ? 'ai_timeout' : 'ai_error', ms: Date.now() - t0 })
        return finish('failed', error.code === 'ai_timeout' ? 'The AI service did not answer in time, so nothing was done. Please try again.' : 'The AI service is not answering right now, so nothing was done. Please try again later.', { stopReason: error.code === 'ai_timeout' ? 'ai_timeout' : 'ai_error' })
      }
      const read = readDecision(reply?.content, allowed)
      if (read.error) {
        turn.errors++
        step({ kind: 'decision', status: 'invalid', code: 'bad_decision', ms: Date.now() - t0 })
        turn.observations.push({ problem: read.error })
        continue
      }
      const d = read.decision
      step({ kind: 'decision', status: 'ok', ms: Date.now() - t0 })
      if (d.type === 'ask') return finish('needs_input', d.message, { listingIds: d.listingIds })
      if (d.type === 'answer') return finish('answered', d.message, { listingIds: d.listingIds })

      // A tool call: limits, then validation, then the call itself as the signed-in user.
      const tool = TOOLS[d.tool]
      if (turn.toolCalls >= LIMITS.toolCalls) {
        turn.observations.push({ tool: d.tool, refused: 'No tool calls left in this turn. Answer with what you have.' })
        step({ kind: 'tool', tool: d.tool, status: 'refused', code: 'tool_limit', label: 'Stopped: step limit' })
        continue
      }
      let args
      try {
        args = tool.validate(d.args, ctx)
      } catch (error) {
        if (!(error instanceof ToolInputError)) throw error
        turn.errors++
        turn.observations.push({ tool: d.tool, error: toolError(error) })
        step({ kind: 'tool', tool: d.tool, status: 'invalid', code: 'invalid_arguments', label: null })
        continue
      }
      const key = `${d.tool}:${JSON.stringify(args)}`
      if (calls.has(key)) {
        turn.errors++
        turn.observations.push({ tool: d.tool, refused: 'You already made this exact call in this turn; use its result.' })
        step({ kind: 'tool', tool: d.tool, status: 'refused', code: 'repeated_call', label: null })
        continue
      }
      calls.add(key)
      turn.toolCalls++
      const t1 = Date.now()
      try {
        const result = await withTimeout(Promise.resolve().then(() => tool.run(ctx, args)), Math.min(LIMITS.toolTimeoutMs, left()), 'tool_timeout')
        for (const l of [...(result.listings || []), ...(result.listing ? [result.listing] : [])]) if (l && typeof l === 'object' && l.id) seen.set(l.id, l)
        if (d.tool === 'search_listings') ctx.state.criteria = result.criteria_used
        if (d.tool === 'get_viewing_slots') offer = ctx.state.offers[0]
        const label = tool.label(args, result)
        step({ kind: 'tool', tool: d.tool, status: 'ok', label, ms: Date.now() - t1 })
        if (tool.consequential) {
          action = { id: result.action_id }
          const a = describeAction(db, db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(action.id))
          return finish('awaiting_approval', `I have prepared a viewing request for ${a.properties.map((p) => p.title).join(', ')} at ${result.when ?? 'the time you chose'}. Nothing is sent yet: press Confirm to send it to ${result.agent_name ?? 'your agent'}. It is booked in their Google Calendar only after they confirm it.`)
        }
        turn.observations.push({ tool: d.tool, result })
      } catch (error) {
        const e = toolError(error.code === 'tool_timeout' ? new AppError(504, 'tool_timeout', 'This step took too long.') : error)
        if (e.code === 'tool_failed' || e.code === 'tool_timeout') { turn.errors++; console.error(`[agent] run ${runId.slice(0, 8)} tool ${d.tool} failed: ${String(error?.message || error).slice(0, 200)}`) }
        turn.observations.push({ tool: d.tool, error: e })
        step({ kind: 'tool', tool: d.tool, status: 'error', code: e.code, label: `${d.tool.replace(/_/g, ' ')}: ${e.message}`.slice(0, 200), ms: Date.now() - t1 })
      }
    }
  } catch (error) {
    db.prepare("UPDATE agent_runs SET status = 'failed', stop_reason = 'internal_error', finished_at = ? WHERE id = ? AND status = 'running'").run(now(), runId)
    throw error
  } finally {
    db.prepare('UPDATE agent_conversations SET busy_until = NULL WHERE id = ?').run(conv.id)
  }
}

/** A conversation and its messages, for the page to show again. Only the owner's. */
export function loadAgentConversation(db, user, id) {
  requireRole(user, 'buyer')
  const conv = ownConversation(db, id, user.id)
  expireActions(db, user.id)
  const actions = Object.fromEntries(db.prepare('SELECT * FROM agent_actions WHERE conversation_id = ?').all(conv.id).map((r) => [r.id, describeAction(db, r)]))
  const messages = db.prepare('SELECT id, role, content, payload, created_at FROM agent_messages WHERE conversation_id = ? ORDER BY id').all(conv.id)
    .map((m) => { const p = parse(m.payload); return { id: m.id, role: m.role, content: m.content, createdAt: m.created_at, ...(p || {}), action: p?.actionId ? actions[p.actionId] : null } })
  return { conversationId: conv.id, messages }
}

function ownAction(db, user, id) {
  const row = typeof id === 'string' ? db.prepare('SELECT * FROM agent_actions WHERE id = ? AND user_id = ?').get(id, user.id) : null
  if (!row) throw new AppError(404, 'action_not_found', 'No such request.')
  return row
}

/**
 * The buyer's Confirm: sends the prepared viewing request, once. A second click (or a retry) gets the first
 * result back; it never creates a second request. The request is booked only when the agent confirms it.
 */
export async function confirmAgentAction(db, vs, user, id) {
  requireRole(user, 'buyer')
  expireActions(db, user.id)
  let row = ownAction(db, user, id)
  if (row.status === 'completed' || row.status === 'failed') return { action: describeAction(db, row), repeated: true }
  if (row.status === 'expired') throw new AppError(409, 'action_expired', 'This request expired. Ask the assistant to check free times again.')
  if (row.status === 'cancelled') throw new AppError(409, 'action_cancelled', 'This request was cancelled.')
  if (row.status === 'executing') throw new AppError(409, 'action_in_progress', 'This request is already being sent.')
  const claimed = db.prepare("UPDATE agent_actions SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'awaiting_confirmation'").run(now(), row.id).changes
  if (!claimed) return confirmAgentAction(db, vs, user, id)
  const params = parse(row.params)
  let status = 'completed'
  let result = null
  let error = null
  try {
    // The same request already sent (from this card or the listing page): reuse it, do not create another.
    const prof = db.prepare('SELECT lead_id FROM buyer_profiles WHERE user_id = ?').get(user.id)
    const same = prof?.lead_id && db.prepare("SELECT id FROM viewings WHERE lead_id = ? AND requested_by = ? AND start_at = ? AND property_ids = ? AND status IN ('draft','booking','booked')")
      .get(prof.lead_id, user.id, new Date(params.start).toISOString(), JSON.stringify(params.propertyIds))
    if (same) result = { viewingId: same.id, status: 'requested', alreadyRequested: true }
    else {
      const r = await requestViewing(db, vs, user, { propertyIds: params.propertyIds, start: params.start, note: 'Requested through the DealSaathi assistant.' })
      result = { viewingId: r.viewing.id, status: r.viewing.status, when: r.viewing.when, agentName: r.viewing.agentName }
    }
  } catch (e) {
    if (!(e instanceof AppError)) {
      db.prepare("UPDATE agent_actions SET status = 'awaiting_confirmation', updated_at = ? WHERE id = ?").run(now(), row.id)
      throw e
    }
    status = 'failed'
    error = e.message
  }
  db.prepare('UPDATE agent_actions SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?').run(status, result ? JSON.stringify(result) : null, error, now(), row.id)
  row = db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(row.id)
  addMessage(db, row.conversation_id, 'assistant', status === 'completed'
    ? `Your viewing request was sent to ${result.agentName || 'your agent'}${result.when ? ` for ${result.when}` : ''}. It is not booked yet: it is booked in their Google Calendar when they confirm it. You can follow it in My viewings.`
    : `The viewing request was not sent: ${error}`, { status: status === 'completed' ? 'action_completed' : 'action_failed' })
  console.log(`[agent] action ${row.id.slice(0, 8)} request_viewing ${status}`)
  return { action: describeAction(db, row) }
}

export function cancelAgentAction(db, user, id) {
  requireRole(user, 'buyer')
  expireActions(db, user.id)
  const row = ownAction(db, user, id)
  const changed = db.prepare("UPDATE agent_actions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'awaiting_confirmation'").run(now(), row.id).changes
  // Nothing was sent for a cancelled or expired request: report its state. A sent one is cancelled in My viewings.
  if (!changed && !['cancelled', 'expired'].includes(row.status)) throw new AppError(409, 'action_not_pending', 'This request can no longer be cancelled here. Use My viewings.')
  return { action: describeAction(db, db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(row.id)) }
}

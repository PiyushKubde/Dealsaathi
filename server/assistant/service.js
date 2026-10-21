// The assistant: AI reads the broker's words, this code decides what happens. The only action it can
// prepare is "create a lead in the local database", and only a Confirm click from the review card runs it.
import { randomUUID } from 'node:crypto'
import { now, transaction } from '../db.js'
import { AppError } from '../errors.js'
import { createLead, findDuplicates, getLead } from '../leads/service.js'
import { leadCode, missingForCreate } from '../leads/validate.js'
import { EXTRACTION_PROMPT, EXTRACTION_SCHEMA, buildAiMessage, describeAiError, groundFields, parseExtraction } from './extract.js'

const MAX_MESSAGE = 2000
const MISSING_LABELS = { full_name: 'full name', customer_type: 'whether they are a buyer, seller, tenant or landlord', phone_or_email: 'a phone number or email address' }

const json = (v) => JSON.stringify(v)
const parse = (s) => (s ? JSON.parse(s) : null)

function addMessage(db, conversationId, role, content, payload = null) {
  db.prepare('INSERT INTO messages (conversation_id, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(conversationId, role, content, payload ? json(payload) : null, now())
}

function getConversation(db, id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id)
}

function pendingAction(db, conversationId) {
  const row = db.prepare("SELECT * FROM actions WHERE conversation_id = ? AND status = 'awaiting_confirmation' ORDER BY created_at DESC LIMIT 1").get(conversationId)
  return row ? { ...row, params: parse(row.params) } : null
}

/** The review card the browser renders: the draft, what is missing, and anything to double-check. */
function describeAction(db, action) {
  const { draft, sources, uncertain, warnings } = action.params
  return {
    id: action.id,
    type: action.type,
    status: action.status,
    draft,
    sources,
    missing: missingForCreate(draft),
    uncertain,
    warnings,
    duplicates: findDuplicates(db, draft)
  }
}

function spokenText(db, conversationId) {
  return db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user'").all(conversationId).map((m) => m.content).join('\n')
}

/**
 * One broker message. Returns { conversationId, status, reply, action? } where status is
 * needs_info | ready_for_review | cancelled | unsupported.
 */
export async function handleMessage(db, ai, { conversationId, message }) {
  if (typeof message !== 'string' || !message.trim()) throw new AppError(400, 'validation_failed', 'Type a message first.')
  if (message.length > MAX_MESSAGE) throw new AppError(400, 'validation_failed', `Messages must be ${MAX_MESSAGE} characters or fewer.`)
  if (!ai.configured) throw new AppError(503, 'ai_not_configured', 'AI is not configured: add the viaSocket values to .env and restart. You can still add leads with the form.')

  let conversation = conversationId ? getConversation(db, conversationId) : null
  if (conversationId && !conversation) throw new AppError(404, 'conversation_not_found', 'That conversation no longer exists. Start a new one.')
  if (!conversation) {
    const id = randomUUID()
    const ts = now()
    db.prepare('INSERT INTO conversations (id, thread_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, `lead-${id}`, 'open', ts, ts)
    conversation = getConversation(db, id)
  }
  const cid = conversation.id
  addMessage(db, cid, 'user', message.trim())
  const pending = pendingAction(db, cid)

  let extraction
  try {
    const reply = await ai.send({
      threadId: conversation.thread_id,
      message: buildAiMessage(message.trim(), pending?.params.draft),
      prompt: EXTRACTION_PROMPT,
      responseType: 'json_schema',
      jsonSchema: EXTRACTION_SCHEMA
    })
    extraction = parseExtraction(reply?.content)
  } catch (error) {
    const appError = describeAiError(error)
    addMessage(db, cid, 'assistant', appError.message, { status: 'ai_error', code: appError.code })
    appError.details = { conversationId: cid }
    throw appError
  }

  const respond = (status, reply, action = null) => {
    addMessage(db, cid, 'assistant', reply, { status, actionId: action?.id ?? null })
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), cid)
    return { conversationId: cid, status, reply, action: action ? describeAction(db, action) : null }
  }

  const { intent } = extraction
  if (intent === 'cancel') {
    if (!pending) return respond('unsupported', 'There is no draft to cancel.')
    db.prepare("UPDATE actions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'awaiting_confirmation'").run(now(), pending.id)
    return respond('cancelled', 'Cancelled. Nothing was saved.')
  }
  if (intent === 'other') {
    return respond('unsupported', 'Right now I can only add new leads. Try something like “Add Rahul Sharma, a buyer looking for a 2 BHK in Pune, phone 98765 43210”. To search, edit or delete leads, use the Leads page.')
  }

  const grounded = groundFields(extraction.fields, spokenText(db, cid))
  const warnings = [...extraction.warnings, ...grounded.warnings]
  const extracted = grounded.fields

  // A create_lead naming someone else starts a fresh draft; anything else adds to the pending one.
  const startsOver = pending && intent === 'create_lead' && extracted.full_name && pending.params.draft.full_name &&
    extracted.full_name.toLowerCase() !== pending.params.draft.full_name.toLowerCase()
  let action
  transaction(db, () => {
    if (pending && !startsOver) {
      const draft = { ...pending.params.draft, ...extracted }
      const sources = { ...pending.params.sources, ...Object.fromEntries(Object.keys(extracted).map((k) => [k, 'ai'])) }
      const uncertain = [...pending.params.uncertain.filter((u) => !(u.field in extracted)), ...extraction.uncertain]
      const params = { draft, sources, uncertain, warnings }
      db.prepare('UPDATE actions SET params = ?, updated_at = ? WHERE id = ?').run(json(params), now(), pending.id)
      action = { ...pending, params }
    } else {
      if (startsOver) db.prepare("UPDATE actions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), pending.id)
      const params = {
        draft: extracted,
        sources: Object.fromEntries(Object.keys(extracted).map((k) => [k, 'ai'])),
        uncertain: extraction.uncertain,
        warnings
      }
      const id = randomUUID()
      const ts = now()
      db.prepare("INSERT INTO actions (id, conversation_id, type, params, status, created_at, updated_at) VALUES (?, ?, 'create_lead', ?, 'awaiting_confirmation', ?, ?)")
        .run(id, cid, json(params), ts, ts)
      action = { id, type: 'create_lead', status: 'awaiting_confirmation', params }
    }
  })

  const missing = missingForCreate(action.params.draft)
  const prefix = startsOver ? 'Started a new draft (the previous one was cancelled, nothing saved). ' : ''
  if (missing.length) {
    return respond('needs_info', `${prefix}I filled in what I understood. I still need ${missing.map((m) => MISSING_LABELS[m]).join(' and ')}. Tell me here or fill it in on the card. Nothing has been saved yet.`, action)
  }
  return respond('ready_for_review', `${prefix}Here is what I understood. Check and correct the details, then press Confirm and save. Nothing has been saved yet.`, action)
}

/**
 * Saves the reviewed lead. `fields` is what the broker left on the review card; it is validated again here.
 * Safe to call twice: a completed action answers with the lead it already saved.
 */
export function confirmAction(db, actionId, { fields, allowSameName = false } = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new AppError(400, 'validation_failed', 'Send the reviewed fields.')
  const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId)
  if (!row) throw new AppError(404, 'action_not_found', 'That request no longer exists.')
  if (row.status === 'completed') {
    const { lead_id } = parse(row.result)
    return { alreadySaved: true, lead: getLead(db, lead_id), leadId: lead_id }
  }
  if (row.status === 'cancelled') throw new AppError(409, 'action_cancelled', 'This draft was cancelled, so it cannot be saved. Start a new one.')
  if (row.type !== 'create_lead') throw new AppError(400, 'unsupported_action', 'This action is not supported.')

  try {
    return transaction(db, () => {
      const lead = createLead(db, fields, { via: 'assistant', allowSameName })
      const done = db.prepare("UPDATE actions SET status = 'completed', result = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_confirmation'")
        .run(json({ lead_id: lead.id }), now(), actionId)
      if (done.changes !== 1) throw new AppError(409, 'action_changed', 'This draft changed while saving. Reload and try again.')
      if (row.conversation_id) addMessage(db, row.conversation_id, 'assistant', `Saved ${lead.full_name} as lead ${leadCode(lead.id)} in the local database.`, { status: 'completed', actionId, leadId: lead.id })
      return { alreadySaved: false, lead, leadId: lead.id }
    })
  } catch (error) {
    if (error instanceof AppError) throw error
    db.prepare('UPDATE actions SET error = ?, updated_at = ? WHERE id = ?').run('database_error', now(), actionId)
    throw new AppError(500, 'save_failed', 'The lead could not be saved to the local database, so nothing was saved. Please try again.')
  }
}

export function cancelAction(db, actionId) {
  const row = db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId)
  if (!row) throw new AppError(404, 'action_not_found', 'That request no longer exists.')
  if (row.status === 'completed') throw new AppError(409, 'already_saved', 'This lead was already saved. Delete it from the Leads page if you no longer want it.')
  if (row.status === 'awaiting_confirmation') {
    transaction(db, () => {
      db.prepare("UPDATE actions SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), actionId)
      if (row.conversation_id) addMessage(db, row.conversation_id, 'assistant', 'Cancelled. Nothing was saved.', { status: 'cancelled', actionId })
    })
  }
  return { status: 'cancelled' }
}

/** A conversation as the chat screen shows it after a reload. */
export function loadConversation(db, id) {
  const conversation = getConversation(db, id)
  if (!conversation) throw new AppError(404, 'conversation_not_found', 'That conversation no longer exists.')
  const messages = db.prepare('SELECT role, content, payload, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(id)
    .map((m) => ({ ...m, payload: parse(m.payload) }))
  const pending = pendingAction(db, id)
  return { conversationId: id, messages, action: pending ? describeAction(db, pending) : null }
}

// Test harness: a fresh in-memory database, a fake AI and the real HTTP app on a random port.
import { openDatabase } from '../server/db.js'
import { createApp } from '../server/app.js'

/** A stand-in for viaSocket AI: answers from a queue and records every call. */
export function fakeAi(...answers) {
  const ai = {
    configured: true,
    calls: [],
    queue: [...answers],
    async send(params) {
      ai.calls.push(params)
      const next = ai.queue.shift()
      if (next === undefined) throw new Error('fake AI: no answer queued')
      if (next instanceof Error) throw next
      return { threadId: params.threadId, messageId: 'm1', content: next, finishReason: 'completed' }
    }
  }
  return ai
}

/** An answer in the shape the extraction schema asks for. */
export function extraction(intent, lead = {}, uncertain = []) {
  const base = {
    full_name: null, customer_type: null, email: null, phone: null, location: null, property_type: null,
    property_interest: null, bedrooms: null, budget_min_inr: null, budget_max_inr: null, source: null, notes: null
  }
  return { intent, lead: { ...base, ...lead }, uncertain }
}

export async function startApp({ ai = fakeAi(), db = openDatabase(':memory:'), auth } = {}) {
  const app = createApp({ db, ai, auth })
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null, text }
  }
  return { db, ai, base, call, close: () => new Promise((r) => server.close(r)) }
}

export const leadCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM leads').get().n

/** Makes every insert into leads fail, as a broken disk would. */
export function breakLeadInserts(db) {
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON leads BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;")
  return () => db.exec('DROP TRIGGER fail_insert')
}

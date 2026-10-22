// Migrating an existing (schema 5) database to the marketplace schema: nothing lost, ownership filled in, a backup made.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, SCHEMA_VERSION } from '../server/db.js'
import { startApp } from './helpers.js'
import { createSession, sessionCookie } from '../server/auth.js'

/** A schema-5 database shaped like production: one broker, leads with history, listings, matches, a viewing, rent. */
function seedV5(file) {
  const db = openDatabase(file, { upTo: 5 })
  const ts = '2026-10-01T10:00:00.000Z'
  db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('usr_000000000000000001', 'asha@example.com', 'Asha Broker', 'scrypt$x$y', ?)").run(ts)
  const lead = db.prepare("INSERT INTO leads (full_name, email, email_norm, phone, phone_norm, customer_type, preferred_location, bedrooms, budget_max, status, created_at, updated_at) VALUES ('Rahul Sharma', 'rahul@example.com', 'rahul@example.com', '9876543210', '9876543210', 'buyer', 'Baner, Pune', 2, 5000000, 'new', ?, ?)").run(ts, ts).lastInsertRowid
  db.prepare("INSERT INTO lead_activities (lead_id, type, summary, via, user_id, created_at) VALUES (?, 'created', 'Lead created', 'form', 'usr_000000000000000001', ?)").run(lead, ts)
  db.prepare("INSERT INTO leads (full_name, phone, phone_norm, customer_type, status, created_at, updated_at) VALUES ('Old Seller', '9000000099', '9000000099', 'seller', 'contacted', ?, ?)").run(ts, ts)
  const prop = db.prepare("INSERT INTO properties (title, listing_type, property_type, bedrooms, price, city, locality, status, created_by, created_at, updated_at) VALUES ('2 BHK in Baner', 'sale', 'apartment', 2, 4800000, 'Pune', 'Baner', 'available', 'usr_000000000000000001', ?, ?)").run(ts, ts).lastInsertRowid
  db.prepare("INSERT INTO property_matches (property_id, lead_id, score, reasons, status, created_at, updated_at) VALUES (?, ?, 90, '{\"score\":90,\"reasons\":[\"In Baner\"],\"gaps\":[]}', 'suggested', ?, ?)").run(prop, lead, ts, ts)
  db.prepare("INSERT INTO connections (user_id, service_id, app_name, auth_id, created_at, updated_at) VALUES ('usr_000000000000000001', 'rowo0bqrhj5g', 'Gmail', 'auth_1', ?, ?)").run(ts, ts)
  db.prepare("INSERT INTO automation_settings (user_id, key, enabled, config, updated_at) VALUES ('usr_000000000000000001', 'new_lead_alert', 1, '{\"channel\":\"gmail\",\"connectionId\":1,\"emailTo\":\"team@agency.in\"}', ?)").run(ts)
  db.prepare("INSERT INTO tenancies (user_id, property_label, tenant_name, rent_amount, due_day, lease_start, tracking_from, created_at, updated_at) VALUES ('usr_000000000000000001', 'Flat 4B', 'Priya Nair', 28000, 5, '2026-10-01', '2026-10-01', ?, ?)").run(ts, ts)
  db.close()
}

test('a schema-5 database migrates to the marketplace schema with every record kept and a backup beside it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-migrate-'))
  const file = join(dir, 'dealsaathi.db')
  try {
    seedV5(file)
    const before = new DatabaseSync(file)
    const counts = (d) => Object.fromEntries(['users', 'leads', 'lead_activities', 'properties', 'property_matches', 'connections', 'automation_settings', 'tenancies'].map((t) => [t, d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]))
    const was = counts(before)
    before.close()

    const lines = []
    const db = openDatabase(file, { log: (l) => lines.push(l) })
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version, SCHEMA_VERSION)
    assert.deepEqual(counts(db), was, 'no row lost')
    const backups = readdirSync(dir).filter((f) => f.includes(`.pre-v${SCHEMA_VERSION}-`) && f.endsWith('.bak'))
    assert.equal(backups.length, 1)
    assert.match(lines[0], new RegExp(`Backed up the database before migrating v5 → v${SCHEMA_VERSION}`))
    const backup = new DatabaseSync(join(dir, backups[0]))
    assert.equal(backup.prepare('SELECT version FROM schema_version').get().version, 5, 'the backup is the untouched v5 data')
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 2)
    backup.close()

    assert.equal(db.prepare('SELECT role FROM users').get().role, 'agent', 'existing accounts become agents')
    assert.ok(db.prepare("SELECT 1 FROM agent_profiles WHERE user_id = 'usr_000000000000000001'").get())
    const leads = db.prepare('SELECT full_name, assigned_agent_id, assignment_rule FROM leads ORDER BY id').all().map((r) => ({ ...r }))
    assert.deepEqual(leads, [
      { full_name: 'Rahul Sharma', assigned_agent_id: 'usr_000000000000000001', assignment_rule: 'migrated_creator' },
      { full_name: 'Old Seller', assigned_agent_id: 'usr_000000000000000001', assignment_rule: 'migrated_only_account' }
    ])
    const p = db.prepare('SELECT owner_user_id, agent_id, listing_state, published_at FROM properties').get()
    assert.equal(p.owner_user_id, 'usr_000000000000000001')
    assert.equal(p.listing_state, 'published')
    assert.ok(p.published_at)
    const m = db.prepare('SELECT status, fingerprint, score FROM property_matches').get()
    assert.equal(m.status, 'suggested')
    assert.equal(m.fingerprint, null, 'an old match keeps no fingerprint, so it is not re-announced')

    // The migrated broker signs in and works as before; re-matching does not announce the old match.
    const user = { id: 'usr_000000000000000001', cookie: sessionCookie(createSession(db, 'usr_000000000000000001')) }
    const t = await startApp({ db, withUser: false })
    try {
      assert.equal((await t.call('/api/leads', { as: user })).body.total, 2)
      assert.equal((await t.call('/api/leads/1/matches', { as: user })).body.matches.length, 1)
      await t.call('/api/leads/1', { method: 'PATCH', body: { lead: { bedrooms: 2, notes: 'touch' } }, as: user })
      await t.call('/api/properties/1', { method: 'PATCH', body: { property: { notes: 'touch' } }, as: user })
      await t.idle()
      assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'match'").get().n, 0)
    } finally { await t.close() }

    // Opening again migrates nothing and makes no further backup.
    db.close()
    openDatabase(file).close()
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.bak')).length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a fresh database is created at the latest schema with no backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-fresh-'))
  try {
    const db = openDatabase(join(dir, 'new.db'))
    assert.equal(db.prepare('SELECT version FROM schema_version').get().version, SCHEMA_VERSION)
    db.close()
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.bak')))
    assert.ok(existsSync(join(dir, 'new.db')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('foreign keys are enforced and a fresh schema has no dangling references', () => {
  const db = openDatabase(':memory:')
  const fk = db.prepare('PRAGMA foreign_key_check').all()
  assert.deepEqual(fk, [])
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
})

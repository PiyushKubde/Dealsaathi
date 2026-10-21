// SQLite storage (Node's built-in node:sqlite). Every query is a prepared statement with bound parameters.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MIGRATIONS = [
  `
  CREATE TABLE leads (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name          TEXT    NOT NULL,
    email              TEXT,
    email_norm         TEXT,
    phone              TEXT,
    phone_norm         TEXT,
    source             TEXT,
    customer_type      TEXT    NOT NULL CHECK (customer_type IN ('buyer','seller','tenant','landlord')),
    property_type      TEXT,
    property_interest  TEXT,
    bedrooms           INTEGER,
    preferred_location TEXT,
    budget_min         INTEGER,
    budget_max         INTEGER,
    status             TEXT    NOT NULL DEFAULT 'new',
    assigned_broker    TEXT,
    notes              TEXT,
    created_at         TEXT    NOT NULL,
    updated_at         TEXT    NOT NULL
  );
  CREATE UNIQUE INDEX leads_email_unique ON leads(email_norm) WHERE email_norm IS NOT NULL;
  CREATE UNIQUE INDEX leads_phone_unique ON leads(phone_norm) WHERE phone_norm IS NOT NULL;
  CREATE INDEX leads_updated ON leads(updated_at);

  CREATE TABLE lead_activities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    type       TEXT    NOT NULL,
    summary    TEXT    NOT NULL,
    details    TEXT,
    via        TEXT    NOT NULL,
    created_at TEXT    NOT NULL
  );
  CREATE INDEX lead_activities_lead ON lead_activities(lead_id, created_at);

  CREATE TABLE idempotency_keys (
    key        TEXT PRIMARY KEY,
    scope      TEXT NOT NULL,
    status     INTEGER NOT NULL,
    response   TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE conversations (
    id         TEXT PRIMARY KEY,
    thread_id  TEXT NOT NULL UNIQUE,
    state      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content         TEXT NOT NULL,
    payload         TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, id);

  CREATE TABLE actions (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    type            TEXT NOT NULL,
    params          TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('awaiting_confirmation','executing','completed','failed','cancelled')),
    result          TEXT,
    error           TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  `
]

export function openDatabase(file = process.env.DATABASE_FILE || 'data/dealsaathi.db') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;')
  migrate(db)
  return db
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT version FROM schema_version').get()
  let version = row ? row.version : 0
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
  while (version < MIGRATIONS.length) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version])
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1)
    })
    version++
  }
}

const depth = new WeakMap()

/** Runs fn inside a transaction, rolling back on any error. Nested calls use savepoints. */
export function transaction(db, fn) {
  const level = depth.get(db) || 0
  const sp = `sp${level}`
  db.exec(level ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE')
  depth.set(db, level + 1)
  try {
    const out = fn()
    db.exec(level ? `RELEASE ${sp}` : 'COMMIT')
    return out
  } catch (error) {
    db.exec(level ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK')
    throw error
  } finally {
    depth.set(db, level)
  }
}

export const now = () => new Date().toISOString()

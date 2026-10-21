import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

// Migrations are applied in order and recorded in schema_migrations. Embarko adds its own
// _litestream_* tables to every SQLite file under DATA_DIR; nothing here touches them.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE leads (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    full_name TEXT NOT NULL,
    email TEXT,
    email_norm TEXT,
    phone TEXT,
    phone_norm TEXT,
    source TEXT,
    category TEXT NOT NULL CHECK (category IN ('buyer','seller','tenant','landlord')),
    property_interest TEXT,
    preferred_location TEXT,
    budget_min INTEGER,
    budget_max INTEGER,
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new','contacted','interested','viewing_scheduled','negotiating','won','lost')),
    assigned_broker TEXT,
    notes TEXT,
    is_sample INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX leads_owner_email ON leads(owner_id, email_norm) WHERE email_norm IS NOT NULL;
  CREATE UNIQUE INDEX leads_owner_phone ON leads(owner_id, phone_norm) WHERE phone_norm IS NOT NULL;

  CREATE TABLE properties (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    listing_type TEXT NOT NULL CHECK (listing_type IN ('sale','rent')),
    property_type TEXT NOT NULL,
    city TEXT NOT NULL,
    locality TEXT,
    address TEXT,
    price INTEGER NOT NULL,
    bedrooms INTEGER,
    area_sqft INTEGER,
    amenities TEXT NOT NULL DEFAULT '[]',
    available INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    is_sample INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE viewings (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    lead_id INTEGER NOT NULL REFERENCES leads(id),
    property_id INTEGER REFERENCES properties(id),
    property_label TEXT,
    start_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 60,
    time_zone TEXT NOT NULL,
    broker TEXT,
    location TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK (status IN ('proposed','booking','booked','booking_unverified','booking_failed','cancelled','completed')),
    availability TEXT,
    calendar_event_id TEXT,
    calendar_response TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE rent_records (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    tenant_name TEXT NOT NULL,
    tenant_email TEXT,
    tenant_phone TEXT,
    property_id INTEGER REFERENCES properties(id),
    property_label TEXT NOT NULL,
    amount INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'unknown'
      CHECK (payment_status IN ('unpaid','partial','paid','unknown')),
    last_payment_date TEXT,
    last_payment_amount INTEGER,
    reminder_status TEXT NOT NULL DEFAULT 'none'
      CHECK (reminder_status IN ('none','drafted','sent','failed')),
    notes TEXT,
    is_sample INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('lead_followup','rent_reminder')),
    lead_id INTEGER REFERENCES leads(id),
    rent_id INTEGER REFERENCES rent_records(id),
    channel TEXT NOT NULL DEFAULT 'gmail',
    recipient TEXT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','sending','sent','unconfirmed','failed')),
    provider_message_id TEXT,
    error TEXT,
    generated_by TEXT NOT NULL DEFAULT 'manual',
    sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT,
    state TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- Every consequential operation goes through here: proposed → executing → succeeded | failed,
  -- or proposed → cancelled. The status transition is the duplicate-execution guard.
  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    conversation_id TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed'
      CHECK (status IN ('proposed','executing','succeeded','failed','cancelled')),
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE integrations (
    owner_id INTEGER NOT NULL REFERENCES users(id),
    service_id TEXT NOT NULL,
    auth_id TEXT NOT NULL,
    script_id TEXT,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (owner_id, service_id)
  );

  -- Flows a user built in viaSocket's prebuilt UI, recorded from its flow events. webhook_url runs the
  -- user's apps, so it is stored server-side and never sent back to the browser.
  CREATE TABLE automations (
    owner_id INTEGER NOT NULL REFERENCES users(id),
    flow_id TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL,
    webhook_url TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (owner_id, flow_id)
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER,
    event TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `
]

export function openDatabase(dataDir) {
  let file = ':memory:'
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true })
    file = path.join(dataDir, 'dealsaathi.db')
  }
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version))
  MIGRATIONS.forEach((sql, index) => {
    const version = index + 1
    if (applied.has(version)) return
    db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString())
    })()
  })
}

export function nowIso() {
  return new Date().toISOString()
}

export function audit(db, ownerId, event, detail) {
  db.prepare('INSERT INTO audit_log (owner_id, event, detail) VALUES (?, ?, ?)').run(
    ownerId ?? null,
    event,
    detail === undefined ? null : JSON.stringify(detail)
  )
}

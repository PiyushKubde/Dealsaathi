// SQLite storage (Node's built-in node:sqlite). Every query is a prepared statement with bound parameters.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  `,
  // 2: accounts, viaSocket connections, follow-ups and automations
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  ALTER TABLE conversations ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE lead_activities ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

  -- A user's connected app account. auth_id stays on the server.
  CREATE TABLE connections (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id TEXT NOT NULL,
    app_name   TEXT NOT NULL,
    icon_url   TEXT,
    auth_id    TEXT NOT NULL,
    label      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, auth_id)
  );

  -- An enabled app (viaSocket's run endpoint for one connection). script_id is a credential: server only.
  CREATE TABLE enabled_apps (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    auth_id    TEXT NOT NULL,
    service_id TEXT NOT NULL,
    script_id  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, auth_id)
  );

  CREATE TABLE followups (
    id            TEXT PRIMARY KEY,
    lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    channel       TEXT NOT NULL,
    recipient     TEXT NOT NULL,
    from_address  TEXT,
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('awaiting_confirmation','sending','sent','failed','unknown','cancelled')),
    result        TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    sent_at       TEXT
  );
  CREATE INDEX followups_lead ON followups(lead_id, created_at);

  -- Flows a user built in the prebuilt UI, as last read back from viaSocket.
  CREATE TABLE automation_flows (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    flow_id    TEXT NOT NULL,
    title      TEXT,
    status     TEXT,
    last_event TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, flow_id)
  );
  `,
  // 3: property listings and property ↔ buyer matches
  `
  CREATE TABLE properties (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL,
    listing_type  TEXT    NOT NULL CHECK (listing_type IN ('sale','rent')),
    property_type TEXT    NOT NULL CHECK (property_type IN ('apartment','independent_house','villa','plot','commercial','other')),
    bedrooms      INTEGER,
    price         INTEGER NOT NULL CHECK (price > 0),
    city          TEXT    NOT NULL,
    locality      TEXT,
    address       TEXT,
    area_sqft     INTEGER,
    amenities     TEXT,
    status        TEXT    NOT NULL DEFAULT 'available' CHECK (status IN ('available','under_offer','sold','rented','off_market')),
    is_sample     INTEGER NOT NULL DEFAULT 0,
    notes         TEXT,
    created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
  );
  CREATE INDEX properties_status ON properties(status, listing_type);

  CREATE TABLE property_matches (
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    score       INTEGER NOT NULL,
    reasons     TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','dismissed')),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    PRIMARY KEY (property_id, lead_id)
  );
  CREATE INDEX property_matches_lead ON property_matches(lead_id);
  `,
  // 4: curated automations, their runs, follow-up reminders, recommendation emails
  `
  CREATE TABLE automation_settings (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 0,
    config     TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE automation_runs (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key          TEXT NOT NULL,
    trigger      TEXT NOT NULL,
    subject_type TEXT,
    subject_id   TEXT,
    status       TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','skipped','unknown')),
    summary      TEXT,
    error        TEXT,
    details      TEXT,
    dedupe_key   TEXT UNIQUE,
    started_at   TEXT NOT NULL,
    finished_at  TEXT
  );
  CREATE INDEX automation_runs_user ON automation_runs(user_id, key, started_at);

  CREATE TABLE reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    reason     TEXT NOT NULL,
    detail     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX reminders_user ON reminders(user_id, status);

  -- Small facts the server must remember between runs (e.g. when the scheduler last checked).
  CREATE TABLE app_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  ALTER TABLE leads ADD COLUMN follow_up_on TEXT;
  ALTER TABLE followups ADD COLUMN kind TEXT NOT NULL DEFAULT 'followup';
  ALTER TABLE followups ADD COLUMN property_ids TEXT;
  `,
  // 5: viewings, post-viewing feedback, tenancies and rent
  `
  CREATE TABLE viewings (
    id                     TEXT PRIMARY KEY,
    user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lead_id                INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    property_ids           TEXT NOT NULL,
    calendar_connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    calendar_id            TEXT,
    start_at               TEXT NOT NULL,
    end_at                 TEXT NOT NULL,
    timezone               TEXT NOT NULL,
    location               TEXT,
    invite_lead            INTEGER NOT NULL DEFAULT 0,
    note                   TEXT,
    status                 TEXT NOT NULL CHECK (status IN ('draft','booking','booked','failed','unknown','completed','no_show','cancelled')),
    event_id               TEXT,
    event_link             TEXT,
    error                  TEXT,
    confirmation_status    TEXT NOT NULL DEFAULT 'not_sent' CHECK (confirmation_status IN ('not_sent','not_configured','sent','failed','unknown')),
    confirmation_detail    TEXT,
    ended_noticed_at       TEXT,
    outcome_at             TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
  );
  -- One live booking per broker per start time: two clicks or two tabs cannot book the same slot twice.
  CREATE UNIQUE INDEX viewings_one_per_slot ON viewings(user_id, start_at) WHERE status IN ('booking','booked');
  CREATE INDEX viewings_lead ON viewings(lead_id);
  CREATE INDEX viewings_user_status ON viewings(user_id, status, end_at);

  CREATE TABLE feedback_requests (
    id                 TEXT PRIMARY KEY,
    viewing_id         TEXT NOT NULL UNIQUE REFERENCES viewings(id) ON DELETE CASCADE,
    lead_id            INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash         TEXT NOT NULL UNIQUE,
    status             TEXT NOT NULL CHECK (status IN ('created','sent','send_failed','send_unknown','submitted','expired')),
    send_detail        TEXT,
    expires_at         TEXT NOT NULL,
    response           TEXT,
    preference_changes TEXT,
    submitted_at       TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );

  -- Listings a lead has said no to (from feedback): matching leaves them out from then on.
  CREATE TABLE lead_property_exclusions (
    lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (lead_id, property_id)
  );
  ALTER TABLE leads ADD COLUMN excluded_localities TEXT;

  CREATE TABLE tenancies (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    property_id    INTEGER REFERENCES properties(id) ON DELETE SET NULL,
    property_label TEXT NOT NULL,
    tenant_lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    tenant_name    TEXT NOT NULL,
    tenant_email   TEXT,
    tenant_phone   TEXT,
    reference      TEXT,
    rent_amount    INTEGER NOT NULL CHECK (rent_amount > 0),
    currency       TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    due_day        INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 28),
    lease_start    TEXT NOT NULL,
    lease_end      TEXT,
    tracking_from  TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
    reminders_opt_out INTEGER NOT NULL DEFAULT 0,
    notes          TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX tenancies_user ON tenancies(user_id, status);

  -- One obligation per tenancy per month. Paid only from a verified Razorpay status or a broker's recorded payment.
  CREATE TABLE rent_dues (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    tenancy_id          INTEGER NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
    period              TEXT NOT NULL,
    due_date            TEXT NOT NULL,
    amount              INTEGER NOT NULL,
    amount_paid         INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_paid','paid','waived','cancelled')),
    paid_at             TEXT,
    verification_source TEXT CHECK (verification_source IN ('razorpay','manual')),
    link_attempt        INTEGER NOT NULL DEFAULT 0,
    payment_link_id     TEXT,
    payment_link_url    TEXT,
    payment_link_status TEXT,
    payment_link_ref    TEXT UNIQUE,
    payment_link_error  TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE (tenancy_id, period)
  );
  CREATE INDEX rent_dues_status ON rent_dues(status, due_date);

  CREATE TABLE rent_payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    due_id      INTEGER NOT NULL REFERENCES rent_dues(id) ON DELETE CASCADE,
    amount      INTEGER NOT NULL CHECK (amount > 0),
    paid_on     TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('razorpay','manual')),
    external_id TEXT,
    recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    note        TEXT,
    created_at  TEXT NOT NULL,
    UNIQUE (source, external_id)
  );

  CREATE TABLE rent_reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    due_id     INTEGER NOT NULL REFERENCES rent_dues(id) ON DELETE CASCADE,
    stage      TEXT NOT NULL,
    channel    TEXT NOT NULL,
    recipient  TEXT,
    status     TEXT NOT NULL CHECK (status IN ('sent','failed','unknown','skipped')),
    detail     TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX rent_reminders_due ON rent_reminders(due_id, created_at);

  -- Audit trail for tenancies and rent: every payment, verification, waiver, link and status change.
  CREATE TABLE rent_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenancy_id INTEGER NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
    due_id     INTEGER REFERENCES rent_dues(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    detail     TEXT NOT NULL,
    user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX rent_events_tenancy ON rent_events(tenancy_id, created_at);
  `
]

/** Where the database lives: DATABASE_FILE, else the host's persistent DATA_DIR (Embarko), else ./data. */
export function databaseFile(env = process.env) {
  if (env.DATABASE_FILE) return env.DATABASE_FILE
  return env.DATA_DIR ? join(env.DATA_DIR, 'dealsaathi.db') : 'data/dealsaathi.db'
}

export function openDatabase(file = databaseFile()) {
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

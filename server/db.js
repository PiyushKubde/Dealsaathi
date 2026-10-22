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
  `,
  // 6: three-sided marketplace — roles and profiles, ownership and assignment, publication state,
  // durable domain events (the processing queue), notifications, buyer viewing requests, tenancy parties.
  `
  ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('buyer','seller','agent'));

  CREATE TABLE agent_profiles (
    user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    phone           TEXT,
    agency          TEXT,
    service_areas   TEXT NOT NULL DEFAULT '[]',
    accepting_leads INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  INSERT INTO agent_profiles (user_id, created_at, updated_at) SELECT id, created_at, created_at FROM users;

  -- A buyer's requirements live in their own lead row (leads.buyer_user_id), so matching has one source.
  CREATE TABLE buyer_profiles (
    user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    phone            TEXT,
    lead_id          INTEGER UNIQUE REFERENCES leads(id) ON DELETE SET NULL,
    matching_consent INTEGER NOT NULL DEFAULT 0,
    consent_at       TEXT,
    notify_in_app    INTEGER NOT NULL DEFAULT 1,
    allow_agent_email INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE seller_profiles (
    user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    phone             TEXT,
    assigned_agent_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    notify_in_app     INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  -- Who is responsible for a lead, and how that was decided.
  ALTER TABLE leads ADD COLUMN assigned_agent_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE leads ADD COLUMN assignment_rule TEXT;
  ALTER TABLE leads ADD COLUMN assigned_at TEXT;
  ALTER TABLE leads ADD COLUMN buyer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  -- Existing leads: the agent who created them, else the only account (this copy had one shared book).
  UPDATE leads SET assigned_agent_id = (SELECT a.user_id FROM lead_activities a JOIN users u ON u.id = a.user_id
                                        WHERE a.lead_id = leads.id AND a.type = 'created' ORDER BY a.id LIMIT 1),
                   assignment_rule = 'migrated_creator', assigned_at = updated_at;
  UPDATE leads SET assigned_agent_id = (SELECT id FROM users), assignment_rule = 'migrated_only_account', assigned_at = updated_at
    WHERE assigned_agent_id IS NULL AND (SELECT COUNT(*) FROM users) = 1;
  UPDATE leads SET assignment_rule = NULL, assigned_at = NULL WHERE assigned_agent_id IS NULL;
  CREATE INDEX leads_agent ON leads(assigned_agent_id, status);
  -- A self-registered buyer may share an email or phone with a lead an agent typed in; agents' own book stays unique.
  DROP INDEX leads_email_unique;
  DROP INDEX leads_phone_unique;
  CREATE UNIQUE INDEX leads_email_unique ON leads(email_norm) WHERE email_norm IS NOT NULL AND buyer_user_id IS NULL;
  CREATE UNIQUE INDEX leads_phone_unique ON leads(phone_norm) WHERE phone_norm IS NOT NULL AND buyer_user_id IS NULL;

  ALTER TABLE properties ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE properties ADD COLUMN agent_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE properties ADD COLUMN listing_state TEXT NOT NULL DEFAULT 'published' CHECK (listing_state IN ('draft','published','unpublished','archived'));
  ALTER TABLE properties ADD COLUMN published_at TEXT;
  UPDATE properties SET owner_user_id = created_by, agent_id = created_by, published_at = created_at;
  CREATE INDEX properties_owner ON properties(owner_user_id);
  CREATE INDEX properties_agent ON properties(agent_id);

  -- Matches keep their history: a match that stops fitting is withdrawn (with the reason), not deleted.
  CREATE TABLE property_matches_v6 (
    property_id      INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    lead_id          INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    score            INTEGER NOT NULL,
    reasons          TEXT    NOT NULL,
    status           TEXT    NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','dismissed','withdrawn')),
    fingerprint      TEXT,
    withdrawn_reason TEXT,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL,
    PRIMARY KEY (property_id, lead_id)
  );
  INSERT INTO property_matches_v6 (property_id, lead_id, score, reasons, status, created_at, updated_at)
    SELECT property_id, lead_id, score, reasons, status, created_at, updated_at FROM property_matches;
  DROP TABLE property_matches;
  ALTER TABLE property_matches_v6 RENAME TO property_matches;
  CREATE INDEX property_matches_lead ON property_matches(lead_id, status);

  -- The processing queue: every platform event is written in the same transaction as the change it records,
  -- then processed (and retried) by the event processor. dedupe_key stops one fact from being queued twice.
  CREATE TABLE domain_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    type            TEXT NOT NULL,
    subject_type    TEXT NOT NULL,
    subject_id      TEXT NOT NULL,
    actor_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
    agent_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
    payload         TEXT NOT NULL DEFAULT '{}',
    dedupe_key      TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed','skipped')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    locked_until    TEXT,
    last_error      TEXT,
    result          TEXT,
    created_at      TEXT NOT NULL,
    processed_at    TEXT
  );
  CREATE INDEX domain_events_due ON domain_events(status, next_attempt_at);
  CREATE INDEX domain_events_subject ON domain_events(subject_type, subject_id);
  CREATE INDEX domain_events_agent ON domain_events(agent_id, id);

  -- What each person was told, in the app or through an integration. One row per fact and recipient.
  CREATE TABLE notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT,
    link         TEXT,
    subject_type TEXT,
    subject_id   TEXT,
    channel      TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app','gmail','slack','whatsapp')),
    status       TEXT NOT NULL CHECK (status IN ('unread','read','sending','sent','failed','unknown','skipped')),
    detail       TEXT,
    event_id     INTEGER REFERENCES domain_events(id) ON DELETE SET NULL,
    dedupe_key   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    read_at      TEXT
  );
  CREATE INDEX notifications_user ON notifications(user_id, channel, status, created_at);

  ALTER TABLE viewings ADD COLUMN requested_by TEXT REFERENCES users(id) ON DELETE SET NULL;

  ALTER TABLE tenancies ADD COLUMN landlord_email TEXT;
  ALTER TABLE tenancies ADD COLUMN landlord_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE tenancies ADD COLUMN tenant_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

  ALTER TABLE connections ADD COLUMN verified_at TEXT;
  ALTER TABLE connections ADD COLUMN verify_status TEXT;
  ALTER TABLE connections ADD COLUMN verify_detail TEXT;
  `,
  // 7: verified email, password reset, explicit tenancy invitations. A tenancy was linked to accounts by an
  // unverified email (v6); those links are removed here and must be re-made by invitation or a verified email.
  `
  ALTER TABLE users ADD COLUMN email_verified_at TEXT;

  -- One-time tokens sent by email (verification, password reset). Only the SHA-256 is stored.
  CREATE TABLE auth_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX auth_tokens_user ON auth_tokens(user_id, purpose);

  -- An agent's explicit invitation for one person to see a tenancy as its tenant or landlord.
  CREATE TABLE tenancy_invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenancy_id  INTEGER NOT NULL REFERENCES tenancies(id) ON DELETE CASCADE,
    party       TEXT NOT NULL CHECK (party IN ('tenant','landlord')),
    email       TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
    expires_at  TEXT NOT NULL,
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    accepted_at TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX tenancy_invites_tenancy ON tenancy_invites(tenancy_id, party, status);

  INSERT INTO rent_events (tenancy_id, type, detail, created_at)
    SELECT id, 'parties_unlinked', 'Account links made from an unverified email were removed by a security update; the agent can invite the tenant or landlord again.', datetime('now')
    FROM tenancies WHERE tenant_user_id IS NOT NULL OR landlord_user_id IS NOT NULL;
  UPDATE tenancies SET tenant_user_id = NULL, landlord_user_id = NULL WHERE tenant_user_id IS NOT NULL OR landlord_user_id IS NOT NULL;

  CREATE TABLE backups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    file       TEXT NOT NULL UNIQUE,
    size       INTEGER NOT NULL,
    sha256     TEXT NOT NULL,
    schema     INTEGER NOT NULL,
    counts     TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('verified','failed','pruned')),
    detail     TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // 8: the AI agent (buyer assistant). New tables only: the lead assistant's conversations/messages/actions are
  // untouched. state holds the conversation's working context (listings and free times shown), never secrets.
  `
  CREATE TABLE agent_conversations (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state      TEXT NOT NULL DEFAULT '{}',
    busy_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX agent_conversations_user ON agent_conversations(user_id, updated_at);

  CREATE TABLE agent_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content         TEXT NOT NULL,
    payload         TEXT,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX agent_messages_conversation ON agent_messages(conversation_id, id);

  -- One row per user message: how the bounded loop ended. Steps say which tools ran, never message text.
  CREATE TABLE agent_runs (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL CHECK (status IN ('running','answered','needs_input','awaiting_approval','stopped','failed')),
    stop_reason     TEXT,
    decisions       INTEGER NOT NULL DEFAULT 0,
    tool_calls      INTEGER NOT NULL DEFAULT 0,
    started_at      TEXT NOT NULL,
    finished_at     TEXT
  );
  CREATE TABLE agent_steps (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    n          INTEGER NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('decision','tool')),
    tool       TEXT,
    status     TEXT NOT NULL CHECK (status IN ('ok','error','invalid','refused')),
    error_code TEXT,
    label      TEXT,
    ms         INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX agent_steps_run ON agent_steps(run_id, n);

  -- A consequential step the agent prepared; only the user's Confirm runs it, at most once.
  CREATE TABLE agent_actions (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK (type IN ('request_viewing')),
    params          TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('awaiting_confirmation','executing','completed','failed','cancelled','expired')),
    result          TEXT,
    error           TEXT,
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX agent_actions_user ON agent_actions(user_id, status);
  `
]

/** Where the database lives: DATABASE_FILE, else the host's persistent DATA_DIR (Embarko), else ./data. */
export function databaseFile(env = process.env) {
  if (env.DATABASE_FILE) return env.DATABASE_FILE
  return env.DATA_DIR ? join(env.DATA_DIR, 'dealsaathi.db') : 'data/dealsaathi.db'
}

export const SCHEMA_VERSION = MIGRATIONS.length

/** `upTo` stops at an older schema version (migration tests build an old database with it). */
export function openDatabase(file = databaseFile(), { log = () => {}, upTo = MIGRATIONS.length } = {}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;')
  migrate(db, file, log, upTo)
  return db
}

/**
 * Applies pending migrations, each in its own transaction. Before migrating a database that already holds
 * data, a full copy is written next to it (VACUUM INTO), because the host keeps no backups.
 */
function migrate(db, file, log, upTo) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT version FROM schema_version').get()
  let version = row ? row.version : 0
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run()
  if (version > 0 && version < upTo && file !== ':memory:') {
    const backup = `${file}.pre-v${upTo}-${Date.now()}.bak`
    db.prepare('VACUUM INTO ?').run(backup)
    log(`Backed up the database before migrating v${version} → v${upTo}: ${backup}`)
  }
  while (version < upTo) {
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

// Database backups and restore.
//
// Backups: a consistent copy (VACUUM INTO) written to BACKUP_DIR, checked before it counts (integrity_check, schema
// version, row counts, SHA-256), recorded in the `backups` table, and pruned to the newest 7 plus one per week for 4
// weeks. The scheduler makes one when the newest is over 24 hours old. Copies live on the same disk as the database,
// so they protect against bad updates and mistakes, not against losing the host: download them off the host too
// (GET /tasks/backups/latest with BACKUP_TOKEN).
//
// Restore (RESTORE_FROM=<backup file name>, then restart): the backup is verified, the current data is copied aside
// (*.pre-restore-<time>.bak), and the backup's tables replace the current ones inside the same database file, in one
// transaction. A marker stops the same restore from running again on the next restart.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const BACKUP_NAME = /^dealsaathi-\d{8}T\d{6}Z\.db$/
const COUNTED = ['users', 'leads', 'properties', 'tenancies', 'rent_payments']
const KEEP_RECENT = 7
const KEEP_WEEKS = 4
const DAY_MS = 24 * 3600 * 1000

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** Opens a copy read-only and checks it is a whole, readable DealSaathi database. Throws with the reason. */
export function inspectBackup(file) {
  const d = new DatabaseSync(file, { readOnly: true })
  try {
    const check = d.prepare('PRAGMA integrity_check').get()
    const verdict = Object.values(check)[0]
    if (verdict !== 'ok') throw new Error(`integrity check failed: ${verdict}`)
    const schema = d.prepare('SELECT version FROM schema_version').get()?.version
    if (!Number.isInteger(schema) || schema < 1) throw new Error('not a DealSaathi database (no schema version)')
    const tables = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name))
    const counts = Object.fromEntries(COUNTED.filter((t) => tables.has(t)).map((t) => [t, d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]))
    return { schema, counts }
  } finally { d.close() }
}

export function createBackups({ db, dir, log = (l) => console.log(l) }) {
  if (!dir) return { enabled: false, due: async () => null, run: async () => null, list: () => [], latest: () => null }
  mkdirSync(dir, { recursive: true })
  const record = (row) => db.prepare('INSERT INTO backups (file, size, sha256, schema, counts, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (file) DO UPDATE SET status = excluded.status, detail = excluded.detail')
    .run(row.file, row.size ?? 0, row.sha256 ?? '', row.schema ?? 0, JSON.stringify(row.counts ?? {}), row.status, row.detail ?? null, new Date().toISOString())

  function run(reason = 'scheduled') {
    const name = `dealsaathi-${stamp()}.db`
    const partial = join(dir, `${name}.partial`)
    try {
      if (existsSync(partial)) unlinkSync(partial)
      db.prepare('VACUUM INTO ?').run(partial)
      const info = inspectBackup(partial)
      const digest = sha256(partial)
      renameSync(partial, join(dir, name))
      const size = statSync(join(dir, name)).size
      record({ file: name, size, sha256: digest, schema: info.schema, counts: info.counts, status: 'verified', detail: reason })
      const pruned = prune()
      log(`[backup] ${name} verified (${(size / 1024).toFixed(0)} KB, schema v${info.schema}, ${JSON.stringify(info.counts)})${pruned ? `; ${pruned} old backup(s) pruned` : ''}`)
      return { file: name, size, sha256: digest, ...info, pruned }
    } catch (error) {
      try { if (existsSync(partial)) unlinkSync(partial) } catch { /* nothing left to clean */ }
      record({ file: name, status: 'failed', detail: String(error.message).slice(0, 300) })
      log(`[backup] ${name} FAILED: ${error.message}`)
      return { file: name, error: error.message }
    }
  }

  /** Keeps the newest 7 verified backups plus the newest of each of the last 4 weeks. */
  function prune() {
    const rows = db.prepare("SELECT file, created_at FROM backups WHERE status = 'verified' ORDER BY created_at DESC, id DESC").all()
    const keep = new Set(rows.slice(0, KEEP_RECENT).map((r) => r.file))
    const weeks = new Set()
    for (const r of rows) {
      const week = Math.floor(Date.parse(r.created_at) / (7 * DAY_MS))
      if (weeks.size < KEEP_WEEKS && !weeks.has(week)) { weeks.add(week); keep.add(r.file) }
    }
    let n = 0
    for (const r of rows) {
      if (keep.has(r.file)) continue
      try { unlinkSync(join(dir, r.file)) } catch { /* already gone */ }
      db.prepare("UPDATE backups SET status = 'pruned' WHERE file = ?").run(r.file)
      n++
    }
    return n
  }

  const latest = () => {
    const row = db.prepare("SELECT * FROM backups WHERE status = 'verified' ORDER BY created_at DESC, id DESC LIMIT 1").get()
    return row && existsSync(join(dir, row.file)) ? { ...row, path: join(dir, row.file), counts: JSON.parse(row.counts) } : null
  }

  return {
    enabled: true,
    dir,
    run,
    latest,
    /** Makes a backup when the newest verified one is older than a day (the scheduler calls this every 15 minutes). */
    due() {
      const last = latest()
      return !last || Date.now() - Date.parse(last.created_at) >= DAY_MS ? run('daily') : null
    },
    list: () => db.prepare('SELECT file, size, sha256, schema, counts, status, detail, created_at FROM backups ORDER BY id DESC LIMIT 50').all().map((r) => ({ ...r, counts: JSON.parse(r.counts) })),
    files: () => readdirSync(dir).filter((f) => BACKUP_NAME.test(f))
  }
}

/**
 * Replaces the database's contents with a backup's, inside the same file. Call before the app opens the database.
 * Returns what happened; throws (leaving the database untouched) when the backup is not usable.
 */
export function restoreFromBackup({ file, dir, name, log = (l) => console.log(l) }) {
  if (!name) return { restored: false }
  const marker = join(dir, 'restore-applied.json')
  if (existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).name === name) {
    log(`[restore] ${name} was already restored; nothing to do. Remove RESTORE_FROM from the settings.`)
    return { restored: false, alreadyApplied: true }
  }
  if (!BACKUP_NAME.test(name)) throw new Error(`RESTORE_FROM must be a backup file name like dealsaathi-20261022T101500Z.db, not "${basename(String(name))}"`)
  const source = join(dir, name)
  if (!existsSync(source)) throw new Error(`Backup ${name} is not in the backup folder`)
  const info = inspectBackup(source)
  const live = new DatabaseSync(file)
  const aside = `${file}.pre-restore-${stamp()}.bak`
  try {
    live.prepare('VACUUM INTO ?').run(aside)
    live.exec('PRAGMA foreign_keys = OFF')
    live.prepare('ATTACH DATABASE ? AS b').run(source)
    const own = (schema) => live.prepare(`SELECT type, name, sql FROM ${schema}.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'`).all()
    live.exec('BEGIN IMMEDIATE')
    try {
      for (const t of own('main').filter((o) => o.type === 'table')) live.exec(`DROP TABLE main."${t.name}"`)
      const objects = own('b')
      for (const t of objects.filter((o) => o.type === 'table')) {
        live.exec(t.sql)
        live.exec(`INSERT INTO main."${t.name}" SELECT * FROM b."${t.name}"`)
      }
      for (const o of objects.filter((x) => x.type !== 'table')) live.exec(o.sql)
      const seq = live.prepare("SELECT 1 FROM b.sqlite_master WHERE name = 'sqlite_sequence'").get()
      if (seq) { live.exec('DELETE FROM main.sqlite_sequence'); live.exec('INSERT INTO main.sqlite_sequence SELECT * FROM b.sqlite_sequence') }
      const bad = live.prepare('PRAGMA main.foreign_key_check').all()
      if (bad.length) throw new Error(`the backup has ${bad.length} broken reference(s)`)
      live.exec('COMMIT')
    } catch (error) {
      live.exec('ROLLBACK')
      throw error
    }
    live.exec('DETACH DATABASE b')
  } finally {
    live.close()
  }
  writeFileSync(marker, JSON.stringify({ name, at: new Date().toISOString(), previousCopy: basename(aside) }))
  log(`[restore] Restored ${name} (schema v${info.schema}, ${JSON.stringify(info.counts)}). The data before the restore is kept in ${basename(aside)}.`)
  return { restored: true, ...info, previousCopy: aside }
}

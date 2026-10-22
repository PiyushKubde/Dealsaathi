// Backups and restore, on temporary copies only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../server/db.js'
import { createBackups, inspectBackup, restoreFromBackup } from '../server/backup.js'
import { startApp } from './helpers.js'

const RAHUL = { full_name: 'Rahul Sharma', customer_type: 'buyer', phone: '9876543210', preferred_location: 'Pune' }
const tmp = () => mkdtempSync(join(tmpdir(), 'ds-backup-'))

test('a backup is a verified, complete copy; failures are recorded; old copies are pruned', async () => {
  const dir = tmp()
  try {
    const file = join(dir, 'live.db')
    const db = openDatabase(file)
    const backups = createBackups({ db, dir: join(dir, 'backups'), log: () => {} })
    const t = await startApp({ db, backups })
    await t.call('/api/leads', { method: 'POST', body: { lead: RAHUL } })
    await t.idle()
    const b = backups.run('test')
    assert.equal(b.error, undefined)
    assert.match(b.file, /^dealsaathi-\d{8}T\d{6}Z\.db$/)
    assert.deepEqual(b.counts.leads, 1)
    assert.equal(inspectBackup(join(dir, 'backups', b.file)).schema, b.schema)
    assert.equal(backups.latest().file, b.file)
    assert.equal(backups.due(), null, 'not due again within a day')
    // 12 more daily backups: only the newest 7 plus weekly ones stay.
    for (let i = 1; i <= 12; i++) {
      t.db.prepare('UPDATE backups SET created_at = ? WHERE file = ?').run(new Date(Date.now() - i * 86400000).toISOString(), backups.latest().file)
      await new Promise((r) => setTimeout(r, 1050)) // file names have one-second precision
      backups.run('test')
    }
    const kept = t.db.prepare("SELECT COUNT(*) AS n FROM backups WHERE status = 'verified'").get().n
    assert.ok(kept >= 7 && kept <= 9, `kept ${kept}`)
    assert.equal(readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.db')).length, kept, 'pruned files are deleted')
    // A backup that cannot be written is recorded as failed, and nothing half-written is left.
    const broken = createBackups({ db: t.db, dir: join(dir, 'backups'), log: () => {} })
    const orig = t.db.prepare.bind(t.db)
    t.db.prepare = (sql) => (sql.startsWith('VACUUM INTO') ? { run: () => { throw new Error('disk full (simulated)') } } : orig(sql))
    const f = broken.run('test')
    t.db.prepare = orig
    assert.match(f.error, /disk full/)
    assert.equal(t.db.prepare("SELECT status FROM backups WHERE file = ?").get(f.file).status, 'failed')
    assert.ok(!readdirSync(join(dir, 'backups')).some((x) => x.endsWith('.partial')))
    await t.close()
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('restore: verified backup replaces the data in the same file, the previous data is kept aside, and it runs once', async () => {
  const dir = tmp()
  try {
    const file = join(dir, 'live.db')
    const bdir = join(dir, 'backups')
    let db = openDatabase(file)
    const backups = createBackups({ db, dir: bdir, log: () => {} })
    let t = await startApp({ db, backups })
    const agent = t.user
    await t.call('/api/leads', { method: 'POST', body: { lead: RAHUL } })
    await t.idle()
    const good = backups.run('before-mistake').file
    // A mistake after the backup: the lead is deleted and another added.
    await t.call('/api/leads/1', { method: 'DELETE' })
    await t.call('/api/leads', { method: 'POST', body: { lead: { ...RAHUL, full_name: 'Wrong Person', phone: '9000000077' } } })
    await t.close()
    db.close()

    const lines = []
    assert.throws(() => restoreFromBackup({ file, dir: bdir, name: '../live.db', log: () => {} }), /must be a backup file name/)
    assert.throws(() => restoreFromBackup({ file, dir: bdir, name: 'dealsaathi-20000101T000000Z.db', log: () => {} }), /not in the backup folder/)
    writeFileSync(join(bdir, 'dealsaathi-20000102T000000Z.db'), 'not a database at all')
    assert.throws(() => restoreFromBackup({ file, dir: bdir, name: 'dealsaathi-20000102T000000Z.db', log: () => {} }))
    const r = restoreFromBackup({ file, dir: bdir, name: good, log: (l) => lines.push(l) })
    assert.equal(r.restored, true)
    assert.ok(existsSync(r.previousCopy), 'the data before the restore is kept')
    assert.equal(inspectBackup(r.previousCopy).counts.leads, 1)

    db = openDatabase(file)
    t = await startApp({ db, withUser: false })
    const leads = (await t.call('/api/leads', { as: agent })).body.leads.map((l) => l.full_name)
    assert.deepEqual(leads, ['Rahul Sharma'], 'back to the backup’s data, and the old session still works')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    // A new lead after restore gets a fresh id (AUTOINCREMENT state restored too).
    const added = (await t.call('/api/leads', { method: 'POST', body: { lead: { ...RAHUL, full_name: 'After Restore', phone: '9000000088' } }, as: agent })).body.lead
    assert.ok(added.id >= 2)
    await t.close()
    db.close()
    assert.equal(restoreFromBackup({ file, dir: bdir, name: good, log: () => {} }).alreadyApplied, true, 'restarting does not restore again')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('backup download needs BACKUP_TOKEN; the scheduler makes the daily backup', async () => {
  const dir = tmp()
  try {
    const db = openDatabase(join(dir, 'live.db'))
    const backups = createBackups({ db, dir: join(dir, 'backups'), log: () => {} })
    const token = 'b'.repeat(40)
    const { createApp } = await import('../server/app.js')
    const app = createApp({ db, ai: { configured: false }, backups, backupToken: token, scheduler: { available: true, secret: 'cron-secret-123' } })
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      assert.equal((await fetch(`${base}/tasks/backups/latest`)).status, 401)
      assert.equal((await fetch(`${base}/tasks/backups/latest`, { headers: { authorization: 'Bearer wrong' } })).status, 401)
      assert.equal((await fetch(`${base}/tasks/backups/latest`, { headers: { authorization: `Bearer ${token}` } })).status, 404, 'none yet')
      const tick = await (await fetch(`${base}/tasks/automations`, { headers: { authorization: 'Bearer cron-secret-123' } })).text()
      assert.match(tick, /Backup: dealsaathi-\d{8}T\d{6}Z\.db verified/)
      const tick2 = await (await fetch(`${base}/tasks/automations`, { headers: { authorization: 'Bearer cron-secret-123' } })).text()
      assert.match(tick2, /Backup: up to date/)
      const dl = await fetch(`${base}/tasks/backups/latest`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(dl.status, 200)
      assert.match(dl.headers.get('x-backup-sha256'), /^[0-9a-f]{64}$/)
      assert.ok((await dl.arrayBuffer()).byteLength > 4096)
    } finally { await new Promise((r) => server.close(r)); db.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

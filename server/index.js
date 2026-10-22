// Starts DealSaathi: npm start
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { openDatabase, databaseFile } from './db.js'
import { createBackups, restoreFromBackup } from './backup.js'
import { markInterruptedRuns } from './automations/store.js'
import { createApp } from './app.js'
import { createAuth } from './auth.js'
import { createViasocketGateway, viasocket, viasocketConfigured } from './viasocket.js'

// Embarko (the host) sets DATA_DIR. Hosted, the app is reachable from the internet, so new accounts
// need the team access code in APP_PASSWORD.
const hosted = Boolean(process.env.DATA_DIR)

// AI runs per signed-in user: viaSocket keeps each user's threads under their own id.
const ai = {
  configured: viasocketConfigured,
  send: (params, { userId }) => viasocket.user(String(userId)).ai.send(params)
}

// Embarko creates CRON_SECRET for an app with schedules (embarko.json) and calls /tasks/automations with it.
const scheduler = { available: Boolean(process.env.CRON_SECRET), secret: process.env.CRON_SECRET || null }

const say = (line) => console.log(line.replace(process.env.DATA_DIR || '\u0000', 'DATA_DIR'))
const file = databaseFile()
const backupDir = process.env.BACKUP_DIR || (process.env.DATA_DIR ? join(process.env.DATA_DIR, 'backups') : 'data/backups')
// RESTORE_FROM names a verified backup in the backup folder; it is applied once, before the database is opened.
if (process.env.RESTORE_FROM && existsSync(file)) {
  try {
    restoreFromBackup({ file, dir: backupDir, name: process.env.RESTORE_FROM, log: say })
  } catch (error) {
    say(`[restore] NOT restored, the current data is unchanged: ${error.message}`)
  }
}
const db = openDatabase(file, { log: say })
const interrupted = markInterruptedRuns(db)
const auth = createAuth({ db, accessCode: process.env.APP_PASSWORD, hosted })
const backups = createBackups({ db, dir: backupDir, log: say })
const app = createApp({ db, ai, vs: createViasocketGateway(), auth, behindProxy: hosted, scheduler, backups,
  mailConnection: process.env.SYSTEM_MAIL_CONNECTION || null, backupToken: process.env.BACKUP_TOKEN || null })
const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || (hosted ? '0.0.0.0' : '127.0.0.1') // locally: this computer only

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
app.listen(port, host, () => {
  app.locals.events.kick() // events left pending by a restart are processed now, not at the next schedule
  const last = backups.latest()
  if (!last || Date.now() - Date.parse(last.created_at) > 24 * 3600 * 1000) backups.run('startup')
  console.log(`DealSaathi is running at ${hosted ? `port ${port}` : `http://localhost:${port}`}`)
  const roles = Object.fromEntries(db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all().map((r) => [r.role, r.n]))
  console.log(`Database: ${hosted ? 'DATA_DIR/dealsaathi.db' : databaseFile()} schema v${db.prepare('SELECT version FROM schema_version').get().version} (${count('users')} users ${JSON.stringify(roles)}, ${count('leads')} leads, ${count('properties')} properties, ${count('connections')} connections, ${count('domain_events')} events)`)
  console.log(viasocketConfigured ? 'viaSocket: configured (AI, integrations, automations).' : 'viaSocket: not configured (add the viaSocket values). Leads still work.')
  console.log(`Scheduler: ${scheduler.available ? 'on (/tasks/automations, every 15 minutes)' : 'off (no CRON_SECRET; reminders run only with "Run check now")'}${interrupted ? `; ${interrupted} interrupted run(s) marked unknown` : ''}`)
  console.log(`System email: ${app.locals.mailer.status().available ? 'on' : `off (${app.locals.mailer.status().reason})`}. Backup download: ${(process.env.BACKUP_TOKEN || '').length >= 32 ? 'on' : 'off (no BACKUP_TOKEN)'}.`)
  console.log(`Access: ${auth.mode === 'locked' ? 'LOCKED until APP_PASSWORD is set' : hosted ? 'accounts; buyers and sellers sign up openly, new agents need the team access code' : 'accounts (this computer only)'}`)
})

// Starts DealSaathi: npm start
import { openDatabase, databaseFile } from './db.js'
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

const db = openDatabase()
const auth = createAuth({ db, accessCode: process.env.APP_PASSWORD, hosted })
const app = createApp({ db, ai, vs: createViasocketGateway(), auth, behindProxy: hosted })
const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || (hosted ? '0.0.0.0' : '127.0.0.1') // locally: this computer only

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
app.listen(port, host, () => {
  console.log(`DealSaathi is running at ${hosted ? `port ${port}` : `http://localhost:${port}`}`)
  console.log(`Database: ${hosted ? 'DATA_DIR/dealsaathi.db' : databaseFile()} (${count('users')} users, ${count('leads')} leads, ${count('connections')} connections)`)
  console.log(viasocketConfigured ? 'viaSocket: configured (AI, integrations, automations).' : 'viaSocket: not configured (add the viaSocket values). Leads still work.')
  console.log(`Access: ${auth.mode === 'locked' ? 'LOCKED until APP_PASSWORD is set' : hosted ? 'accounts; new accounts need the team access code' : 'accounts (this computer only)'}`)
})

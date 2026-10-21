// Starts DealSaathi: npm start
import { openDatabase, databaseFile } from './db.js'
import { createApp } from './app.js'
import { createAuth } from './auth.js'
import { viasocket, viasocketConfigured } from './viasocket.js'

// This build has one broker. viaSocket keeps AI threads per user id: a stable string, never an email.
const BROKER_USER_ID = process.env.DEALSAATHI_USER_ID || 'local-broker-1'

// Embarko (the host) sets DATA_DIR. Hosted, the app is reachable from the internet, so it needs a password.
const hosted = Boolean(process.env.DATA_DIR)

const ai = {
  configured: viasocketConfigured,
  send: (params) => viasocket.user(BROKER_USER_ID).ai.send(params)
}

const db = openDatabase()
const auth = createAuth({ password: process.env.APP_PASSWORD, hosted })
const app = createApp({ db, ai, auth, behindProxy: hosted })
const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || (hosted ? '0.0.0.0' : '127.0.0.1') // locally: this computer only

app.listen(port, host, () => {
  console.log(`DealSaathi is running at ${hosted ? `port ${port}` : `http://localhost:${port}`}`)
  console.log(`Database: ${hosted ? 'DATA_DIR/dealsaathi.db' : databaseFile()}`)
  console.log(viasocketConfigured ? 'AI: viaSocket configured.' : 'AI: not configured (add the viaSocket values). The rest of the app works.')
  console.log(`Access: ${auth.mode === 'open' ? 'open (local, no password)' : auth.mode === 'password' ? 'password required' : 'LOCKED until APP_PASSWORD is set'}`)
})

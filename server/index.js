// Starts DealSaathi locally: node --env-file=.env server/index.js  (or: npm start)
import { openDatabase } from './db.js'
import { createApp } from './app.js'
import { viasocket, viasocketConfigured } from './viasocket.js'

// This local build has one broker. viaSocket keeps AI threads per user id: a stable string, never an email.
const BROKER_USER_ID = process.env.DEALSAATHI_USER_ID || 'local-broker-1'

const ai = {
  configured: viasocketConfigured,
  send: (params) => viasocket.user(BROKER_USER_ID).ai.send(params)
}

const db = openDatabase()
const app = createApp({ db, ai })
const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || '127.0.0.1' // this computer only

app.listen(port, host, () => {
  console.log(`DealSaathi is running at http://localhost:${port}`)
  console.log(viasocketConfigured ? 'AI: viaSocket configured.' : 'AI: not configured (add viaSocket values to .env). The rest of the app works.')
})

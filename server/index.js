import { loadDotEnv, readConfig, viasocketConfigured } from './config.js'
import { createApp } from './app.js'

loadDotEnv()
const config = readConfig()
const { app } = createApp(config)

app.listen(config.port, config.host, () => {
  console.log(`DealSaathi is running. Open http://localhost:${config.port} in your browser.`)
  console.log(`  Listening on ${config.host}:${config.port} · data in ${config.dataDir}`)
  if (!config.admin.email || !config.admin.password) {
    console.log('  Sign-in is NOT set up: add DEALSAATHI_ADMIN_EMAIL and DEALSAATHI_ADMIN_PASSWORD to .env, then restart.')
  }
  console.log(
    viasocketConfigured(config)
      ? '  viaSocket: configured (AI assistant, Gmail and Google Calendar can be used).'
      : '  viaSocket: not configured (no VIASOCKET_EMBED_SECRET). Leads, matching, rent and viewing proposals work; AI, email and calendar are off.'
  )
})

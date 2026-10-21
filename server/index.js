import { loadDotEnv, readConfig } from './config.js'
import { createApp } from './app.js'

loadDotEnv()
const config = readConfig()
const { app } = createApp(config)

app.listen(config.port, '0.0.0.0', () => {
  console.log(`DealSaathi listening on port ${config.port}`)
})

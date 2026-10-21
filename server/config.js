import fs from 'node:fs'
import path from 'node:path'

/** Loads KEY=VALUE lines from a local .env without overriding real environment variables. */
export function loadDotEnv(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match || line.trim().startsWith('#')) continue
    const [, key, raw] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2')
  }
}

export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production' || Boolean(env.APP_NAME)
  return {
    port: Number(env.PORT) || 3000,
    dataDir: path.resolve(env.DATA_DIR || './data'),
    production,
    timeZone: env.DEALSAATHI_TIMEZONE || 'Asia/Kolkata',
    admin: {
      email: (env.DEALSAATHI_ADMIN_EMAIL || '').trim().toLowerCase(),
      password: env.DEALSAATHI_ADMIN_PASSWORD || '',
      name: env.DEALSAATHI_ADMIN_NAME || 'Workspace Owner'
    },
    viasocket: {
      orgId: env.VIASOCKET_ORG_ID || '',
      projectId: env.VIASOCKET_PROJECT_ID || '',
      secret: env.VIASOCKET_EMBED_SECRET || '',
      apiUrl: (env.VIASOCKET_API_URL || 'https://flow-api.viasocket.com/').replace(/\/$/, ''),
      // The action runner's host; runAction appends /func/<script_id>.
      runUrl: (env.VIASOCKET_RUN_URL || 'https://flow.sokt.io/func/').replace(/\/(func\/?)?$/, ''),
      aiService: env.VIASOCKET_AI_SERVICE || '',
      aiModel: env.VIASOCKET_AI_MODEL || ''
    }
  }
}

export function viasocketConfigured(config) {
  const v = config.viasocket
  return Boolean(v.orgId && v.projectId && v.secret)
}

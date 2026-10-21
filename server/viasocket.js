// The one viaSocket client, server only: https://flow.viasocket.com/documentation/skill/setup.md
import { ViaSocket } from 'viasocket-apps'

const { VIASOCKET_ORG_ID, VIASOCKET_PROJECT_ID, VIASOCKET_EMBED_SECRET } = process.env

/** True when all three values are in .env. The local UI works without them; viaSocket features do not. */
export const viasocketConfigured = Boolean(VIASOCKET_ORG_ID && VIASOCKET_PROJECT_ID && VIASOCKET_EMBED_SECRET)

export const viasocket = viasocketConfigured
  ? new ViaSocket({
      orgId: VIASOCKET_ORG_ID,
      projectId: VIASOCKET_PROJECT_ID,
      secret: VIASOCKET_EMBED_SECRET
    })
  : null
// everything for one end user: viasocket.user(userId)

const slugCache = new Map()

/**
 * The service_id for a slug. catalog.serviceIdFor first; when it cannot find a slug that the catalog
 * does list (seen for 'gmail' with viasocket-apps 0.7.0), the slug is looked up in catalog.list().
 */
async function serviceIdFor(slug) {
  if (slugCache.has(slug)) return slugCache.get(slug)
  let id
  try {
    id = await viasocket.catalog.serviceIdFor(slug)
  } catch (error) {
    for (let offset = 0; offset < 4000 && !id; offset += 200) {
      const page = await viasocket.catalog.list({ limit: 200, offset })
      if (!page.length) break
      id = page.find((a) => a.slug === slug)?.serviceId
    }
    if (!id) throw error
  }
  slugCache.set(slug, id)
  return id
}

/**
 * Everything DealSaathi asks of viaSocket, as one object so tests can pass a fake.
 * Every method maps to one documented call of viasocket-apps.
 */
export function createViasocketGateway() {
  if (!viasocketConfigured) return { configured: false }
  const user = (id) => viasocket.user(String(id))
  return {
    configured: true,
    search: (text) => viasocket.catalog.search(text),
    versions: (serviceId) => viasocket.catalog.versions(serviceId),
    serviceIdFor,
    versionIdFor: (serviceId, event, version) => viasocket.catalog.versionIdFor(serviceId, event, version),
    token: (userId) => user(userId).token(),
    listConnections: (userId) => user(userId).listConnections(),
    revokeConnection: (userId, authId) => user(userId).revokeConnection(authId),
    listFlows: (userId) => user(userId).listFlows(),
    enable: (userId, serviceId, authId) => user(userId).enable(serviceId, authId),
    setFlowStatus: (userId, scriptId, status) => user(userId).setFlowStatus(scriptId, status),
    listOptions: (userId, actionVersionId, params) => user(userId).listOptions(actionVersionId, params),
    runAction: (scriptId, actionVersionId, inputData) => viasocket.runAction(scriptId, actionVersionId, inputData)
  }
}

// The one viaSocket client, server only: https://flow.viasocket.com/documentation/skill/setup.md
import { ViaSocket } from 'viasocket-apps'

const { VIASOCKET_ORG_ID, VIASOCKET_PROJECT_ID, VIASOCKET_EMBED_SECRET } = process.env

/** True when all three values are in .env. The local UI works without them; AI features do not. */
export const viasocketConfigured = Boolean(VIASOCKET_ORG_ID && VIASOCKET_PROJECT_ID && VIASOCKET_EMBED_SECRET)

export const viasocket = viasocketConfigured
  ? new ViaSocket({
      orgId: VIASOCKET_ORG_ID,
      projectId: VIASOCKET_PROJECT_ID,
      secret: VIASOCKET_EMBED_SECRET
    })
  : null
// everything for one end user: viasocket.user(userId)

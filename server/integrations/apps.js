// The apps DealSaathi works with. This is the whole list the Integrations page shows: no open catalog.
// `actions` are the action_ids the Connect popup asks permission for (connect()'s `actions`).
import { AppError } from '../errors.js'
import { viasocketError } from './service.js'

export const CURATED_APPS = [
  {
    slug: 'gmail', name: 'Gmail', actions: ['rowogelpy0h6'], inUse: true,
    purpose: 'Sends lead alerts, reminders, follow-ups and property recommendations from your own Gmail.',
    usedBy: ['New Lead Alert', 'Property Recommendations', 'Buyer Follow-Up Reminders', 'Follow-up emails']
  },
  {
    slug: 'slack', name: 'Slack', actions: ['row1jrbor'], inUse: true,
    purpose: 'Posts new-lead alerts and follow-up reminders to a channel you choose.',
    usedBy: ['New Lead Alert', 'Buyer Follow-Up Reminders']
  },
  {
    slug: 'google-calendar', name: 'Google Calendar', actions: ['row7kcom7ds1', 'rowuitv4m6uy'], inUse: false,
    purpose: 'Will check your availability and book property viewings.',
    usedBy: ['Property Viewing Scheduler (not built yet)']
  },
  {
    slug: 'whatsapp_business_cloud', name: 'WhatsApp Business', actions: ['rowsd70emhii'], inUse: false,
    purpose: 'Will send approved template messages to buyers and tenants from your own WhatsApp Business number.',
    usedBy: ['Not used yet: needs a Meta-approved message template and DealSaathi’s WhatsApp sending']
  }
]

const iconCache = new Map() // serviceId → { url, at }; the catalog says a day is fine
const DAY = 24 * 60 * 60 * 1000

async function iconFor(vs, serviceId) {
  const hit = iconCache.get(serviceId)
  if (hit && Date.now() - hit.at < DAY) return hit.url
  try {
    const v = await vs.versions(serviceId)
    const url = v?.service?.icon_url || null
    iconCache.set(serviceId, { url, at: Date.now() })
    return url
  } catch {
    return null
  }
}

/** The curated apps with their live service ids and icons. An app viaSocket cannot resolve carries an error. */
export async function curatedApps(vs) {
  return Promise.all(CURATED_APPS.map(async (app) => {
    try {
      const serviceId = await vs.serviceIdFor(app.slug)
      return { ...app, serviceId, iconUrl: await iconFor(vs, serviceId), error: null }
    } catch (error) {
      return { ...app, serviceId: null, iconUrl: null, error: viasocketError(error, `find ${app.name}`).message }
    }
  }))
}

/** Only a curated app may be connected through DealSaathi. */
export async function requireCuratedServiceId(vs, serviceId) {
  const apps = await curatedApps(vs)
  const app = apps.find((a) => a.serviceId && a.serviceId === serviceId)
  if (!app) throw new AppError(400, 'app_not_supported', 'DealSaathi does not use that app.')
  return app
}

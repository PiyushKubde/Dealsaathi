// The curated automations' execution: what triggers each, how its settings are validated, and how a run
// acts through the broker's own connection (Gmail · Send Email or Slack · Send Message, see run.js).
// Every run is recorded; a dedupe key stops one event from acting twice.
import { now } from '../db.js'
import { AppError, validationError } from '../errors.js'
import { getLead, logActivity } from '../leads/service.js'
import { requireOwnConnection } from '../integrations/service.js'
import { ACTIONS, execute, gmailInput, pickOptions, prepareRun, readGmailResult, readSlackResult, serviceIdOf, slackChannels, slackInput } from '../integrations/run.js'
import { CALENDAR_TIMEZONES } from '../time.js'
import { noticeEndedViewings } from '../viewings/service.js'
import { paymentsLive, runRentChecks } from '../rent/service.js'
import { notifyInApp } from '../notifications/service.js'
import { AUTOMATIONS, automation, finishRun, getRun, getSetting, lastRun, listRuns, saveSetting, startRun, usersWithEnabled } from './store.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const CHANNEL_ACTION = { gmail: ACTIONS.gmail_send_email, slack: ACTIONS.slack_send_message }
const ACTIVE_LEAD_STATUSES = ['new', 'contacted', 'qualified', 'viewing_scheduled', 'negotiating']
const AUTOMATIC_ACTIVITY = ['property_matched', 'reminder_created', 'assigned', 'preferences_updated', 'consent_changed']
export const REMINDER_TIMEZONE = 'Asia/Kolkata'

const inr = (n) => (n == null ? null : n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : `₹${n.toLocaleString('en-IN')}`)
const TYPE = { buyer: 'Buyer', seller: 'Seller', tenant: 'Tenant', landlord: 'Landlord' }
const SOURCE = { walk_in: 'Walk-in', referral: 'Referral', website: 'Website', phone_call: 'Phone call', social_media: 'Social media', property_portal: 'Property portal', other: 'Other' }
const todayIn = (tz, date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)

function parseEmails(text) {
  const list = String(text || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!list.length || list.length > 5 || list.some((e) => !EMAIL_RE.test(e) || e.length > 200)) return null
  return [...new Set(list)]
}

/**
 * Checks a channel part of a config: { channel, connectionId, emailTo | slackChannelId }.
 * `live` ({ connections }) adds the checks that need viaSocket. Returns { config, problems[] }.
 */
async function checkChannel(db, vs, user, raw, { live, allowNone = false }) {
  const problems = []
  const channel = raw?.channel ?? raw?.notify
  if (allowNone && (channel === 'none' || channel == null)) return { config: { channel: 'none' }, problems }
  if (!['gmail', 'slack'].includes(channel)) return { config: { channel: null }, problems: ['Choose Gmail or Slack.'] }
  const config = { channel, connectionId: raw.connectionId == null || raw.connectionId === '' ? null : Number(raw.connectionId) }
  const action = CHANNEL_ACTION[channel]
  let connection = null
  if (!config.connectionId) problems.push(`Choose your connected ${action.app} account (connect it on the Integrations page).`)
  else {
    connection = db.prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?').get(config.connectionId, user.id)
    if (!connection) problems.push(`That ${action.app} account is not connected to your DealSaathi account.`)
  }
  if (channel === 'gmail') {
    const emails = parseEmails(raw.emailTo)
    if (!emails) problems.push('Enter one to five email addresses, separated by commas.')
    else config.emailTo = emails.join(', ')
  } else {
    if (typeof raw.slackChannelId !== 'string' || !/^[A-Za-z0-9_-]{2,40}$/.test(raw.slackChannelId)) problems.push('Choose a Slack channel.')
    else { config.slackChannelId = raw.slackChannelId; config.slackChannelLabel = String(raw.slackChannelLabel || '').slice(0, 80) }
  }
  if (connection && live) {
    if (!vs.configured) problems.push('viaSocket is not configured on this server.')
    else {
      const serviceId = await serviceIdOf(vs, action.slug, action.app)
      if (connection.service_id !== serviceId) problems.push(`Choose a ${action.app} account.`)
      const liveConn = live.connections?.find((c) => c.id === connection.auth_id)
      if (live.connections && !liveConn) problems.push(`Your ${action.app} connection no longer exists on viaSocket. Reconnect it on the Integrations page.`)
      else if (liveConn?.isExpired) problems.push(`Your ${action.app} connection has expired. Reconnect it on the Integrations page.`)
      if (channel === 'slack' && config.slackChannelId && live.verifySlack && !problems.length) {
        const options = await slackChannels(db, vs, user.id, connection.id)
        const hit = options.find((o) => o.value === config.slackChannelId)
        if (!hit) problems.push('That Slack channel is not in your workspace’s channel list.')
        else config.slackChannelLabel = hit.label
      }
    }
  }
  return { config, problems }
}

/** One of the broker's own connections to `slug`, checked: theirs, that app, and (with `live`) active on viaSocket. */
async function checkConnection(db, vs, user, connectionId, slug, app, live) {
  if (connectionId == null || connectionId === '') return [`Choose your connected ${app} account (connect it on the Integrations page).`]
  const row = db.prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?').get(Number(connectionId), user.id)
  if (!row) return [`That ${app} account is not connected to your DealSaathi account.`]
  if (!live) return []
  if (!vs.configured) return ['viaSocket is not configured on this server.']
  const serviceId = await serviceIdOf(vs, slug, app)
  if (row.service_id !== serviceId) return [`Choose a ${app} account.`]
  const liveConn = live.connections?.find((c) => c.id === row.auth_id)
  if (live.connections && !liveConn) return [`Your ${app} connection no longer exists on viaSocket. Reconnect it on the Integrations page.`]
  if (liveConn?.isExpired) return [`Your ${app} connection has expired. Reconnect it on the Integrations page.`]
  return []
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

function parseDays(raw) {
  const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean).map(Number)
  if (list.some((n) => !Number.isInteger(n) || n < 1 || n > 60) || list.length > 5) return null
  return [...new Set(list)].sort((a, b) => a - b)
}

/** The settings an automation needs, checked. `live` adds viaSocket checks. */
async function checkConfig(db, vs, user, key, raw, live, scheduler) {
  const def = automation(key)
  if (!def) throw new AppError(404, 'automation_not_found', 'No such automation.')
  if (!def.available) return { config: {}, problems: [def.blocker] }
  if (key === 'buyer_matching') {
    const notify = await checkChannel(db, vs, user, { ...raw, channel: raw?.notify ?? 'none' }, { live, allowNone: true })
    return { config: { notify: notify.config.channel, ...notify.config, channel: undefined }, problems: notify.problems }
  }
  if (key === 'new_lead_alert') return checkChannel(db, vs, user, raw, { live })
  if (key === 'property_recommendations') {
    const { config, problems } = await checkChannel(db, vs, user, { ...raw, channel: 'gmail', emailTo: user.email }, { live })
    return { config: { connectionId: config.connectionId }, problems }
  }
  if (key === 'viewing_scheduler') {
    const problems = []
    const config = {
      calendarConnectionId: raw?.calendarConnectionId ? Number(raw.calendarConnectionId) : null,
      calendarId: typeof raw?.calendarId === 'string' ? raw.calendarId.slice(0, 200) : null,
      calendarLabel: typeof raw?.calendarLabel === 'string' ? raw.calendarLabel.slice(0, 120) : null,
      timezone: raw?.timezone ?? 'Asia/Kolkata',
      dayStart: raw?.dayStart ?? '09:00',
      dayEnd: raw?.dayEnd ?? '19:00',
      durationMinutes: Number(raw?.durationMinutes ?? 60),
      confirmation: raw?.confirmation === 'gmail' ? 'gmail' : 'none',
      gmailConnectionId: raw?.gmailConnectionId ? Number(raw.gmailConnectionId) : null
    }
    problems.push(...await checkConnection(db, vs, user, config.calendarConnectionId, 'google-calendar', 'Google Calendar', live))
    if (!config.calendarId) problems.push('Choose which calendar to book viewings in.')
    if (!CALENDAR_TIMEZONES.includes(config.timezone)) problems.push('Choose a time zone from the list.')
    if (!HHMM.test(config.dayStart) || !HHMM.test(config.dayEnd) || config.dayStart >= config.dayEnd) problems.push('Working hours must be a start time before an end time (HH:MM).')
    if (!Number.isInteger(config.durationMinutes) || config.durationMinutes < 15 || config.durationMinutes > 240 || config.durationMinutes % 15) problems.push('Default length must be 15 minutes to 4 hours, in 15-minute steps.')
    if (config.confirmation === 'gmail') problems.push(...await checkConnection(db, vs, user, config.gmailConnectionId, 'gmail', 'Gmail', live))
    if (live?.verifySlack && !problems.length) {
      const calendars = await pickOptions(db, vs, user.id, config.calendarConnectionId, 'calendar_free_busy', 'calendar_id')
      const hit = calendars.find((c) => c.value === config.calendarId)
      if (!hit) problems.push('That calendar is not in your Google Calendar list.')
      else config.calendarLabel = hit.label
    }
    return { config, problems }
  }
  if (key === 'viewing_feedback') {
    const config = { gmailConnectionId: raw?.gmailConnectionId ? Number(raw.gmailConnectionId) : null, expiryDays: Number(raw?.expiryDays ?? 14) }
    const problems = await checkConnection(db, vs, user, config.gmailConnectionId, 'gmail', 'Gmail', live)
    if (!Number.isInteger(config.expiryDays) || config.expiryDays < 1 || config.expiryDays > 60) problems.push('The link must stay open for 1 to 60 days.')
    return { config, problems }
  }
  if (key === 'rent_reminders') {
    const afterDays = parseDays(raw?.afterDays ?? [3, 7])
    const config = {
      gmailConnectionId: raw?.gmailConnectionId ? Number(raw.gmailConnectionId) : null,
      beforeDays: Number(raw?.beforeDays ?? 3),
      onDue: raw?.onDue !== false,
      afterDays: afterDays ?? [],
      razorpayConnectionId: raw?.razorpayConnectionId ? Number(raw.razorpayConnectionId) : null
    }
    const problems = await checkConnection(db, vs, user, config.gmailConnectionId, 'gmail', 'Gmail', live)
    if (!Number.isInteger(config.beforeDays) || config.beforeDays < 0 || config.beforeDays > 15) problems.push('Send the first reminder 0 to 15 days before the due date.')
    if (!afterDays) problems.push('Overdue reminders: up to five numbers of days from 1 to 60, separated by commas.')
    if (config.razorpayConnectionId && !paymentsLive()) problems.push('Razorpay payment links are not enabled for live use on this server yet (they need a verified real-payment test first). Leave Razorpay unset; payments are then recorded by people.')
    else if (config.razorpayConnectionId) problems.push(...await checkConnection(db, vs, user, config.razorpayConnectionId, 'razorpay', 'Razorpay', live))
    if (!scheduler.available) problems.push('The 15-minute scheduler runs only on the hosted DealSaathi (Embarko). Here you can use “Run check now”.')
    return { config, problems, schedulerProblem: !scheduler.available }
  }
  if (key === 'followup_reminders') {
    const days = Number(raw?.inactiveDays ?? 3)
    const problems = []
    if (!Number.isInteger(days) || days < 1 || days > 90) problems.push('Choose a number of days between 1 and 90.')
    const notify = await checkChannel(db, vs, user, { ...raw, channel: raw?.notify ?? 'none' }, { live, allowNone: true })
    problems.push(...notify.problems)
    if (!scheduler.available) problems.push('The 15-minute scheduler runs only on the hosted DealSaathi (Embarko). Here you can use “Run check now”.')
    return { config: { inactiveDays: days, notify: notify.config.channel, ...notify.config, channel: undefined }, problems, schedulerProblem: !scheduler.available }
  }
  return { config: {}, problems: [] }
}

export function createAutomationEngine({ db, vs, scheduler = { available: false } }) {
  async function liveConnections(userId) {
    if (!vs.configured) return { connections: null }
    try {
      return { connections: await vs.listConnections(userId) }
    } catch {
      return { connections: null, error: 'Could not check your connections with viaSocket just now.' }
    }
  }

  /** Sends one notification through the configured channel. Returns { status, summary, error, details }. */
  async function notify(user, config, { subject, text }) {
    const action = CHANNEL_ACTION[config.channel]
    let prepared
    try {
      prepared = await prepareRun(db, vs, user.id, config.connectionId, action)
    } catch (error) {
      return { status: 'failed', error: error.message || `Could not prepare ${action.app}.` }
    }
    const input = config.channel === 'gmail'
      ? gmailInput({ to: config.emailTo, subject, body: text, fromName: user.name })
      : slackInput({ channelId: config.slackChannelId, text: `*${subject}*\n${text}` })
    const ran = await execute(vs, prepared, input)
    if (ran.outcome !== 'answered') return { status: ran.outcome, error: ran.reason }
    const read = config.channel === 'gmail' ? readGmailResult(ran.result) : readSlackResult(ran.result)
    if (!read.ok) return { status: read.unknown ? 'unknown' : 'failed', error: read.reason }
    return config.channel === 'gmail'
      ? { status: 'succeeded', summary: `Emailed ${config.emailTo} from Gmail (message id ${read.messageId})`, details: { messageId: read.messageId } }
      : { status: 'succeeded', summary: `Posted to Slack ${config.slackChannelLabel || 'channel'} (message ${read.ts})`, details: { ts: read.ts } }
  }

  function leadMessage(lead, actor, via) {
    const v = (x) => (x == null || x === '' ? 'not given' : x)
    const budget = lead.budget_min != null && lead.budget_max != null ? `${inr(lead.budget_min)} – ${inr(lead.budget_max)}`
      : lead.budget_max != null ? `up to ${inr(lead.budget_max)}` : lead.budget_min != null ? `from ${inr(lead.budget_min)}` : null
    const wants = [lead.property_interest, lead.bedrooms != null && !String(lead.property_interest || '').includes('BHK') ? `${lead.bedrooms} BHK` : null].filter(Boolean).join(', ')
    return {
      subject: `New lead: ${lead.full_name} (${TYPE[lead.customer_type]})`,
      text: [
        `${lead.full_name} was added to DealSaathi as lead ${lead.code}.`, '',
        `Type: ${TYPE[lead.customer_type]}`, `Phone: ${v(lead.phone)}`, `Email: ${v(lead.email)}`,
        `Source: ${v(SOURCE[lead.source])}`, `Budget: ${v(budget)}`, `Preferred location: ${v(lead.preferred_location)}`,
        `Looking for: ${v(wants)}`, '', `Added by ${actor?.name || 'a DealSaathi user'}${via === 'assistant' ? ' via the AI assistant (confirmed)' : via === 'form' ? ' via the lead form' : ''}.`
      ].join('\n')
    }
  }

  async function runLeadAlert(runId, user, config, leadId, actor, via) {
    const lead = getLead(db, leadId)
    if (!lead) return finishRun(db, runId, { status: 'skipped', error: 'The lead was deleted before the alert went out.' })
    const out = await notify(user, config, leadMessage(lead, actor, via))
    finishRun(db, runId, out)
    console.log(`[automation] new_lead_alert ${runId} ${out.status}`)
  }

  async function runReminders({ trigger, onlyUser = null, onlyConfig = null }) {
    const targets = onlyUser ? [{ user: onlyUser, config: onlyConfig }] : usersWithEnabled(db, 'followup_reminders')
    const today = todayIn(REMINDER_TIMEZONE)
    const totals = { brokers: 0, created: 0, notified: 0, failed: 0 }
    // Only the agent responsible for a lead is reminded about it. "Activity" is what a person did: automatic
    // entries (matches, reminders, assignment, preference updates from feedback) do not count as contact.
    const leadsOf = db.prepare(`SELECT l.*, (SELECT MAX(a.created_at) FROM lead_activities a WHERE a.lead_id = l.id AND a.type NOT IN (${AUTOMATIC_ACTIVITY.map(() => '?').join(',')})) AS last_activity
                              FROM leads l WHERE l.assigned_agent_id = ? AND l.customer_type IN ('buyer','tenant') AND l.status IN (${ACTIVE_LEAD_STATUSES.map(() => '?').join(',')})`)
    for (const { user, config } of targets) {
      totals.brokers++
      const created = []
      for (const lead of leadsOf.all(...AUTOMATIC_ACTIVITY, user.id, ...ACTIVE_LEAD_STATUSES)) {
        const found = []
        if (lead.follow_up_on && lead.follow_up_on <= today) found.push({ reason: 'follow_up_date', anchor: lead.follow_up_on, detail: `Follow-up date ${lead.follow_up_on} has arrived` })
        const last = [lead.created_at, lead.last_activity].filter(Boolean).sort().at(-1)
        const idleDays = Math.floor((Date.now() - new Date(last).getTime()) / 86400000)
        if (idleDays >= (config.inactiveDays ?? 3)) found.push({ reason: 'no_activity', anchor: last, detail: `No activity recorded for ${idleDays} days (since ${last.slice(0, 10)})` })
        for (const f of found) {
          const ts = now()
          const r = db.prepare(`INSERT INTO reminders (user_id, lead_id, reason, detail, status, dedupe_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`)
            .run(user.id, lead.id, f.reason, f.detail, `${user.id}:${lead.id}:${f.reason}:${f.anchor}`, ts, ts)
          if (r.changes) {
            created.push({ lead, ...f })
            logActivity(db, lead.id, 'reminder_created', `Follow-up reminder: ${f.detail}`, { reason: f.reason }, 'automation', user.id)
            notifyInApp(db, user.id, { kind: 'reminder', title: `Follow up with ${lead.full_name}`, body: f.detail, link: `#/leads/${lead.id}`, subjectType: 'lead', subjectId: lead.id, dedupeKey: `reminder:${user.id}:${lead.id}:${f.reason}:${f.anchor}` })
          }
        }
      }
      if (!created.length) continue
      totals.created += created.length
      const runId = startRun(db, { userId: user.id, key: 'followup_reminders', trigger })
      let out = { status: 'succeeded', summary: `${created.length} new reminder${created.length === 1 ? '' : 's'} in DealSaathi` }
      if (config.notify && config.notify !== 'none') {
        const text = created.map((c) => `• ${c.lead.full_name} (${TYPE[c.lead.customer_type]}): ${c.detail}`).join('\n')
        const sent = await notify(user, { ...config, channel: config.notify }, { subject: `${created.length} lead${created.length === 1 ? '' : 's'} to follow up`, text })
        if (sent.status === 'succeeded') { totals.notified++; out = { ...sent, summary: `${out.summary}; ${sent.summary}` } }
        else { totals.failed++; out = { status: sent.status, summary: `${out.summary}; the notification was not sent`, error: sent.error } }
      }
      finishRun(db, runId, out)
    }
    db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('followup_reminders_last_check', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(JSON.stringify({ trigger, ...totals }), now())
    return totals
  }

  return {
    /** Automation work now runs from the event queue (see events/); nothing is left in flight here. */
    idle: () => Promise.resolve(),

    /** For the event handlers: send through an agent's configured channel, and the New Lead Alert message. */
    notifyThrough: notify,
    leadAlertMessage: leadMessage,

    async cards(user) {
      const live = await liveConnections(user.id)
      const check = db.prepare("SELECT value, updated_at FROM app_state WHERE key = 'followup_reminders_last_check'").get()
      return Promise.all(AUTOMATIONS.map(async (def) => {
        const setting = getSetting(db, user.id, def.key)
        const { problems } = await checkConfig(db, vs, user, def.key, setting.config, live, scheduler)
        const status = !def.available || problems.length ? 'needs_setup' : setting.enabled ? 'enabled' : 'disabled'
        return {
          key: def.key, name: def.name, description: def.description, trigger: def.trigger, action: def.action,
          available: def.available, channels: def.channels, status, enabled: setting.enabled && status === 'enabled',
          problems, config: setting.config, lastRun: lastRun(db, user.id, def.key), warning: live.error ?? null,
          ...(def.key === 'followup_reminders' ? { scheduler: scheduler.available, lastCheck: check ? { ...JSON.parse(check.value), at: check.updated_at } : null } : {})
        }
      }))
    },

    /** Saves settings. Enabling needs a valid config and a working path (checked live); otherwise it is refused. */
    async configure(user, key, { enabled, config }) {
      const def = automation(key)
      if (!def) throw new AppError(404, 'automation_not_found', 'No such automation.')
      if (typeof enabled !== 'boolean') throw validationError({ enabled: 'Say whether it should be on.' })
      if (!def.available) throw new AppError(409, 'not_available', def.blocker)
      const current = getSetting(db, user.id, key)
      const merged = { ...current.config, ...(config && typeof config === 'object' && !Array.isArray(config) ? config : {}) }
      const live = enabled ? { ...(await liveConnections(user.id)), verifySlack: true } : null
      const usesChannel = ['new_lead_alert', 'property_recommendations', 'viewing_scheduler', 'viewing_feedback', 'rent_reminders'].includes(key) || (['followup_reminders', 'buyer_matching'].includes(key) && ['gmail', 'slack'].includes(merged.notify))
      if (enabled && usesChannel && live.connections === null) throw new AppError(503, 'viasocket_unavailable', live.error || 'viaSocket is not configured, so this cannot be switched on.')
      const { config: clean, problems } = await checkConfig(db, vs, user, key, merged, live, scheduler)
      if (enabled && problems.length) throw new AppError(409, 'needs_setup', 'This automation cannot be switched on yet.', { problems })
      saveSetting(db, user.id, key, { enabled, config: clean })
      return (await this.cards(user)).find((c) => c.key === key)
    },

    runs: (user, key) => {
      if (!automation(key)) throw new AppError(404, 'automation_not_found', 'No such automation.')
      return listRuns(db, user.id, key)
    },

    slackChannels: (user, connectionId) => {
      requireOwnConnection(db, user.id, connectionId)
      return slackChannels(db, vs, user.id, connectionId)
    },

    /** Retries a failed (refused, not unknown) lead alert: nothing went out the first time. */
    async retry(user, runId) {
      const run = getRun(db, user.id, runId)
      if (!run) throw new AppError(404, 'run_not_found', 'No such run.')
      if (!run.retryable) throw new AppError(409, 'not_retryable', run.status === 'unknown' ? 'This run’s outcome is unknown, so it is not retried automatically: check first, to avoid sending twice.' : 'Only a failed lead alert can be retried.')
      const setting = getSetting(db, user.id, 'new_lead_alert')
      db.prepare("UPDATE automation_runs SET status = 'running', error = NULL, finished_at = NULL WHERE id = ? AND status = 'failed'").run(runId)
      await runLeadAlert(runId, user, setting.config, Number(run.subjectId), user, 'retry')
      return getRun(db, user.id, runId)
    },

    /** Trigger: the scheduler (every 15 minutes on the hosted app), or "Run check now" for one broker. */
    runReminders,

    /** The calendars of the broker's Google Calendar connection (Free/Busy's calendar_id picker). */
    calendars: (user, connectionId) => {
      requireOwnConnection(db, user.id, connectionId)
      return pickOptions(db, vs, user.id, connectionId, 'calendar_free_busy', 'calendar_id')
    },

    /** Everything the scheduler runs, every 15 minutes. */
    async runScheduled(trigger) {
      const reminders = await runReminders({ trigger })
      const viewingsEnded = noticeEndedViewings(db)
      const rent = await runRentChecks(db, vs, { trigger })
      return { reminders, viewingsEnded, rent }
    },

    /** "Run check now" for rent: the same check, for this broker only (also outside quiet hours). */
    async runRentNow(user) {
      const setting = getSetting(db, user.id, 'rent_reminders')
      const live = await liveConnections(user.id)
      const { config, problems, schedulerProblem } = await checkConfig(db, vs, user, 'rent_reminders', setting.config, live, scheduler)
      const blocking = schedulerProblem ? problems.slice(0, -1) : problems
      if (blocking.length) throw new AppError(409, 'needs_setup', 'Finish the settings first.', { problems: blocking })
      return runRentChecks(db, vs, { trigger: 'Run check now', onlyUser: user, onlyConfig: config, force: true })
    },

    async runRemindersNow(user) {
      const setting = getSetting(db, user.id, 'followup_reminders')
      const live = await liveConnections(user.id)
      const { config, problems, schedulerProblem } = await checkConfig(db, vs, user, 'followup_reminders', setting.config, live, scheduler)
      const blocking = schedulerProblem ? problems.slice(0, -1) : problems
      if (blocking.length) throw new AppError(409, 'needs_setup', 'Finish the settings first.', { problems: blocking })
      return runReminders({ trigger: 'Run check now', onlyUser: user, onlyConfig: config })
    }
  }
}

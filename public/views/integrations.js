import { api, badge, busy, confirmDialog, dateTime, errorText, field, h, humanize, mount, select, statusBadge, toast } from '../lib.js'

const CONNECT_SCRIPT = 'https://flow.viasocket.com/connect.js'
const EMBED_SCRIPT = 'https://embed.viasocket.com/prod-embedcomponent.js'

function loadScript(src, id) {
  if (document.getElementById(id)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.id = id
    script.src = src
    script.onload = resolve
    script.onerror = () => reject(new Error(`Could not load ${new URL(src).host}. Check that your network allows viaSocket.`))
    document.head.append(script)
  })
}

let connectListener = null

/**
 * Connect buttons for the two apps DealSaathi uses. The popup is opened only through viaSocket's
 * openViasocketConnection, from the click itself; the token is fetched before the click so no popup blocker fires.
 */
function appCard(app, { token, onChange }) {
  const card = h('div', { class: 'card stack' })
  const reconnect = app.connected && app.expired
  const label = reconnect ? `Reconnect ${app.name}` : app.connected ? `Connect another ${app.name} account` : `Connect ${app.name}`
  const button = h('button', { class: app.connected && !reconnect ? 'small connect-btn' : 'primary small connect-btn', disabled: !token },
    h('img', { src: app.icon, alt: '' }), label)
  button.onclick = () => {
    if (typeof window.openViasocketConnection !== 'function') return toast('The viaSocket connect script has not loaded.', 'error')
    const options = { filteredActions: app.actionIds, skipActionSelection: true }
    if (reconnect && app.liveAuthId) options.authId = app.liveAuthId
    window.openViasocketConnection(token, app.serviceId, options)
  }
  const forget = h('button', { class: 'small ghost', onclick: async () => {
    if (!(await confirmDialog({ title: `Stop using ${app.name}?`, body: 'DealSaathi forgets this connection. The account stays connected in viaSocket until you disconnect it there.', confirmLabel: 'Stop using it', danger: true }))) return
    await api(`/integrations/${app.serviceId}`, { method: 'DELETE' })
    onChange()
  } }, 'Stop using')

  let state
  if (app.connected && app.expired) state = badge('Connection expired', 'danger')
  else if (app.connected) state = badge('Connected · verified with viaSocket', 'ok')
  else if (app.stored && app.problem) state = badge('Connection missing', 'danger')
  else if (app.stored) state = badge('Saved · not verified', 'warn')
  else state = badge('Not connected')

  mount(card,
    h('div', { class: 'row between' }, h('div', { class: 'row' }, h('img', { class: 'app-icon', src: app.icon, alt: '' }), h('div', {}, h('h2', {}, app.name), h('p', { class: 'small muted' }, app.purpose))), state),
    app.problem ? h('p', { class: 'field-error' }, app.problem) : null,
    h('div', { class: 'row' }, button, app.stored ? forget : null))

  if (app.key === 'googleCalendar' && app.connected) card.append(calendarPicker(app, onChange))
  return card
}

function calendarPicker(app, onChange) {
  const holder = h('div', { class: 'stack tight' },
    h('p', { class: 'small' }, app.settings.calendar_id ? `Booking calendar: ${app.settings.calendar_label}` : h('span', { class: 'field-error' }, 'Choose the calendar viewings should be booked on.')))
  const load = h('button', { class: 'small', onclick: () => busy(load, (async () => {
    try {
      const { calendars } = await api('/integrations/calendar/calendars')
      if (!calendars.length) return toast('Google Calendar returned no calendars for this account.', 'error')
      const choice = select('calendar', calendars.map((c) => [c.value, c.label]), app.settings.calendar_id)
      const save = h('button', { class: 'primary small', onclick: async () => {
        await api('/integrations/calendar/calendar', { method: 'PUT', body: { calendar_id: choice.value, label: choice.selectedOptions[0]?.textContent } })
        toast('Calendar saved.')
        onChange()
      } }, 'Use this calendar')
      holder.append(h('div', { class: 'row' }, field('Calendar', choice), save))
    } catch (e) {
      toast(errorText(e), 'error')
    }
  })()) }, app.settings.calendar_id ? 'Change calendar' : 'Choose calendar')
  holder.append(h('div', {}, load))
  return holder
}

async function automationsSection(token) {
  const list = h('div')
  async function loadList() {
    const { automations } = await api('/automations')
    const live = automations.filter((a) => a.status !== 'deleted')
    mount(list, live.length
      ? h('div', { class: 'list' }, live.map((a) => h('div', { class: 'list-item' }, h('div', {}, h('div', { class: 'title' }, a.title || a.flow_id), h('div', { class: 'small muted' }, `updated ${dateTime(a.updated_at)}`)), statusBadge(a.status === 'active' ? 'succeeded' : a.status))))
      : h('p', { class: 'small muted' }, 'No automations published yet.'))
  }
  const box = h('div', { class: 'embed-box', id: 'viasocket-embed' })
  const open = h('button', { class: 'small', disabled: !token, onclick: async () => {
    try {
      await loadScript(EMBED_SCRIPT, 'viasocket-embed-script')
      open.remove()
      // showEnabled: false because DealSaathi also enables apps through the Apps API for the same users.
      const embed = window.viaSocket.mount({ embedToken: token, parent: box, config: { showEnabled: false, pageheading: 'Automation', pagesubheading: 'Build your own automations across the apps you use.' } })
      embed.on('flow', async (flow) => {
        if (!flow?.id) return
        await api('/automations/events', { method: 'POST', body: { id: flow.id, action: flow.action, title: flow.title, webhookurl: flow.webhookurl } }).catch(() => {})
        loadList()
      })
      embed.on('error', (e) => toast(`viaSocket: ${e?.message || 'the integrations screen reported an error'}`, 'error'))
    } catch (e) {
      toast(errorText(e), 'error')
    }
  } }, 'Open the viaSocket automation builder')
  await loadList()
  return h('div', { class: 'card stack' },
    h('h2', {}, 'Your own automations'),
    h('p', { class: 'small muted' }, 'viaSocket’s builder, inside DealSaathi: connect any of 2,300+ apps and build automations that run on viaSocket, for example a weekly digest or a scheduled reminder. DealSaathi records what you publish.'),
    list, h('div', {}, open), box)
}

function setupGuide(status) {
  return h('div', { class: 'card stack' },
    h('h2', {}, 'Finish setting up viaSocket'),
    h('p', {}, 'DealSaathi uses viaSocket for its AI assistant, Gmail and Google Calendar. The server is missing its signing secret.'),
    h('ol', { class: 'small' },
      h('li', {}, 'Open viaSocket → Integrations → the embed → Install Code (project ', h('span', { class: 'mono' }, status.viasocket.projectId || 'projwZ9V7Wb3'), ').'),
      h('li', {}, 'Copy the embed signing secret.'),
      h('li', {}, 'Add it to the server environment as ', h('span', { class: 'mono' }, 'VIASOCKET_EMBED_SECRET'), ' (in .env locally, or in the hosting provider’s secret settings) along with VIASOCKET_ORG_ID and VIASOCKET_PROJECT_ID, then restart.')),
    h('p', { class: 'small muted' }, 'The secret stays on the server: it is never sent to this browser.'))
}

function dataSection(ctx, onChange) {
  const s = ctx.status.data
  const load = h('button', { class: 'small', onclick: () => busy(load, (async () => {
    const { added } = await api('/sample-data', { method: 'POST' })
    toast(`Loaded ${added} sample records.`)
    await onChange()
  })()) }, 'Load sample leads and rent records')
  const remove = h('button', { class: 'small danger', onclick: async () => {
    if (!(await confirmDialog({ title: 'Remove all sample data?', body: 'Deletes every record marked “Sample”, including sample listings, and any drafts or viewings attached to them. Your own records are untouched.', confirmLabel: 'Remove sample data', danger: true }))) return
    await api('/sample-data', { method: 'DELETE' })
    toast('Sample data removed.')
    await onChange()
  } }, 'Remove sample data')
  return h('div', { class: 'card stack' },
    h('h2', {}, 'Data'),
    h('dl', { class: 'kv small' },
      h('dt', {}, 'Storage'), h('dd', {}, 'SQLite database on this server'),
      h('dt', {}, 'Leads'), h('dd', {}, `${s.leads.real} yours · ${s.leads.sample} sample`),
      h('dt', {}, 'Listings'), h('dd', {}, `${s.properties.real} yours · ${s.properties.sample} sample (no live listing feed is connected)`),
      h('dt', {}, 'Rent records'), h('dd', {}, `${s.rent.real} yours · ${s.rent.sample} sample`)),
    h('div', { class: 'row' }, load, remove))
}

async function activitySection() {
  const { events } = await api('/activity')
  return h('div', { class: 'card' }, h('h2', { style: { marginBottom: '8px' } }, 'Recent activity'),
    events.length
      ? h('div', { class: 'list' }, events.slice(0, 15).map((e) => h('div', { class: 'list-item small' }, h('span', {}, humanize(e.event)), h('span', { class: 'muted' }, dateTime(`${e.created_at}`)))))
      : h('p', { class: 'small muted' }, 'Nothing yet.'))
}

export async function renderIntegrations(container, ctx) {
  const rerender = async () => {
    await ctx.refreshStatus()
    await renderIntegrations(container, ctx)
  }
  const s = ctx.status
  const integrations = await api('/integrations')
  let token = null
  let tokenError = null
  if (s.viasocket.configured) {
    try {
      token = (await api('/viasocket/token')).token
      await loadScript(CONNECT_SCRIPT, 'viasocket-connect-script')
    } catch (e) {
      tokenError = errorText(e)
    }
  }

  if (connectListener) window.removeEventListener('message', connectListener)
  connectListener = async (event) => {
    const type = event.data?.type
    if (type === 'viasocket_connection_success') {
      try {
        await api('/integrations/connected', { method: 'POST', body: { serviceId: event.data.serviceId, authId: event.data.data?.id } })
        toast('Connected.')
        rerender()
      } catch (e) {
        toast(errorText(e), 'error')
      }
    } else if (type === 'viasocket_connection_error') {
      toast(event.data.error?.message || 'viaSocket could not complete the connection.', 'error')
    }
    // viasocket_connection_closed means "nothing yet": a success can still follow, so it changes nothing.
  }
  window.addEventListener('message', connectListener)

  const viasocketState = !s.viasocket.configured
    ? badge('Not configured', 'warn')
    : integrations.verified ? badge('Signing secret verified', 'ok') : badge('Configured · could not verify', 'danger')

  mount(container,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Integrations & settings'), h('p', { class: 'muted' }, 'Apps DealSaathi acts in on your behalf, through viaSocket.'))),
    h('div', { class: 'grid', style: { gap: '16px' } },
      h('div', { class: 'card stack' },
        h('div', { class: 'row between' }, h('h2', {}, 'viaSocket'), viasocketState),
        h('dl', { class: 'kv small' },
          h('dt', {}, 'Organisation'), h('dd', { class: 'mono' }, s.viasocket.orgId || 'not set'),
          h('dt', {}, 'Embed project'), h('dd', { class: 'mono' }, s.viasocket.projectId || 'not set'),
          h('dt', {}, 'AI assistant'), h('dd', {}, s.ai.available ? `${s.ai.provider} · ${s.ai.model}` : 'off until viaSocket is configured')),
        integrations.error ? h('p', { class: 'field-error' }, `viaSocket check failed: ${integrations.error}`) : null,
        tokenError ? h('p', { class: 'field-error' }, tokenError) : null),
      s.viasocket.configured ? null : setupGuide(s),
      h('div', { class: 'grid cols-2' }, integrations.apps.map((app) => appCard(app, { token, onChange: rerender }))),
      s.viasocket.configured && token ? await automationsSection(token) : null,
      dataSection(ctx, rerender),
      await activitySection())
  )
}

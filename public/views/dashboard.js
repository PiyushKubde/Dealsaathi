import { api, badge, budget, date, h, humanize, inr, mount, sampleBadge, statusBadge } from '../lib.js'
import { openLead } from './leads.js'
import { notConfiguredBanner } from './shared.js'

function panel(title, link, content) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, title), link ? h('a', { href: link.href, class: 'small' }, link.text) : null),
    content)
}

const empty = (text) => h('div', { class: 'empty' }, text)

export async function renderDashboard(container, ctx) {
  const d = await api('/dashboard')
  const s = ctx.status
  const rentAttention = [...d.rent.overdue, ...d.rent.dueSoon, ...d.rent.needsVerification]
  const hasSample = s.data.leads.sample || s.data.rent.sample || s.data.properties.sample

  const ask = h('input', { placeholder: 'Ask DealSaathi… e.g. “Find 2BHK flats under ₹50 lakh in Pune”', 'aria-label': 'Ask the assistant' })
  const askForm = h('form', { class: 'row', style: { flexWrap: 'nowrap' } }, ask, h('button', { class: 'primary', type: 'submit' }, 'Ask'))
  askForm.addEventListener('submit', (e) => {
    e.preventDefault()
    sessionStorage.setItem('ds:prefill', ask.value)
    ctx.navigate('assistant')
  })

  mount(container,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, `Good to see you, ${ctx.user.name.split(' ')[0]}`), h('p', { class: 'muted' }, `Today is ${date(s.today)} · ${s.timeZone}`)),
      h('div', { class: 'row' },
        s.ai.available ? badge('AI assistant on', 'ok') : badge('AI not configured', 'warn'),
        s.integrations.gmail ? badge('Gmail connected', 'ok') : badge('Gmail not connected'),
        s.integrations.calendar ? badge('Calendar connected', 'ok') : badge('Calendar not connected'))),
    s.viasocket.configured ? null : notConfiguredBanner('Records, matching and drafts you write yourself all work.'),
    hasSample ? h('div', { class: 'banner sample' }, h('div', {}, h('strong', {}, 'Sample data is present'),
      `Counts below include records marked “Sample”: ${s.data.leads.sample} leads, ${s.data.properties.sample} listings, ${s.data.rent.sample} rent records. Remove them in Integrations → Data.`)) : null,
    h('div', { class: 'card', style: { marginBottom: '16px' } }, h('h2', { style: { marginBottom: '10px' } }, 'AI assistant'), askForm,
      s.ai.available ? null : h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'The assistant needs viaSocket to be configured on the server.')),
    h('div', { class: 'grid cols-4', style: { marginBottom: '16px' } },
      h('div', { class: 'card stat' }, h('span', { class: 'muted small' }, 'Active leads'), h('span', { class: 'value' }, d.totals.activeLeads), h('span', { class: 'small muted' }, `${d.totals.leads} total`)),
      h('div', { class: 'card stat' }, h('span', { class: 'muted small' }, 'Need follow-up'), h('span', { class: 'value' }, d.followUps.length), h('span', { class: 'small muted' }, 'no contact in 3+ days')),
      h('div', { class: 'card stat' }, h('span', { class: 'muted small' }, 'Upcoming viewings'), h('span', { class: 'value' }, d.upcomingViewings.length), h('span', { class: 'small muted' }, `${d.upcomingViewings.filter((v) => v.status === 'booked').length} booked on calendar`)),
      h('div', { class: 'card stat' }, h('span', { class: 'muted small' }, 'Rent needing attention'), h('span', { class: 'value' }, rentAttention.length), h('span', { class: 'small muted' }, `${d.rent.overdue.length} overdue`))),
    h('div', { class: 'grid cols-2' },
      panel('Recent leads', { href: '#/leads', text: 'All leads' }, d.recentLeads.length
        ? h('div', { class: 'list' }, d.recentLeads.map((l) => h('div', { class: 'list-item clickable', onclick: () => openLead(l.id) },
            h('div', {}, h('div', { class: 'row' }, h('span', { class: 'title' }, l.full_name), l.is_sample ? sampleBadge() : null),
              h('div', { class: 'small muted' }, `${humanize(l.category)} · ${budget(l.budget_min, l.budget_max)}`)),
            statusBadge(l.status))))
        : empty('No leads yet.')),
      panel('Leads requiring follow-up', null, d.followUps.length
        ? h('div', { class: 'list' }, d.followUps.map((l) => h('div', { class: 'list-item clickable', onclick: () => openLead(l.id) },
            h('div', {}, h('div', { class: 'title' }, l.full_name),
              h('div', { class: 'small muted' }, l.last_contacted_at ? `Last emailed ${date(l.last_contacted_at)}` : `No email sent · updated ${date(l.updated_at)}`)),
            statusBadge(l.status))))
        : empty(d.totals.activeLeads ? 'Every active lead has been touched in the last 3 days.' : 'No active leads need a follow-up.')),
      panel('Upcoming viewings', { href: '#/viewings', text: 'All viewings' }, d.upcomingViewings.length
        ? h('div', { class: 'list' }, d.upcomingViewings.map((v) => h('div', { class: 'list-item' },
            h('div', {}, h('div', { class: 'title' }, v.property_title || v.property_label), h('div', { class: 'small muted' }, `${v.lead_name} · ${date(v.start_date)} ${v.start_time}`)),
            statusBadge(v.status))))
        : empty('No upcoming viewings.')),
      panel('Rent due and overdue', { href: '#/rent', text: 'Rent tracking' }, rentAttention.length
        ? h('div', { class: 'list' }, rentAttention.slice(0, 6).map((r) => h('div', { class: 'list-item' },
            h('div', {}, h('div', { class: 'row' }, h('span', { class: 'title' }, r.tenant_name), r.is_sample ? sampleBadge() : null),
              h('div', { class: 'small muted' }, `${inr(r.amount)} · due ${date(r.due_date)}`)),
            statusBadge(r.bucket))))
        : empty(s.data.rent.real + s.data.rent.sample ? 'Nothing due in the next 7 days.' : 'No rent records yet.')),
      panel('Recent property matches', { href: '#/properties', text: 'Property matching' }, d.recentMatches.length
        ? h('div', { class: 'list' }, d.recentMatches.map((m) => h('div', { class: 'list-item' },
            h('div', {}, h('div', { class: 'title' }, [m.criteria?.city, m.criteria?.locality, m.criteria?.bedrooms != null ? `${m.criteria.bedrooms} BHK` : null, m.criteria?.budget_max ? `≤ ${inr(m.criteria.budget_max)}` : null].filter(Boolean).join(' · ') || 'Search'),
              h('div', { class: 'small muted' }, date(m.created_at))),
            badge(`${m.count} match${m.count === 1 ? '' : 'es'}`))))
        : empty('Matches found through the assistant appear here.')))
  )
}

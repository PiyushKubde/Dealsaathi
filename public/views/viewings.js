import {
  api, badge, busy, confirmDialog, date, dateTime, errorText, field, formData, h, mount, openDrawer, sampleBadge, select, showIssues, statusBadge, toast
} from '../lib.js'
import { notConfiguredBanner } from './shared.js'

const BOOKING_TEXT = {
  proposed: 'Not booked. This is a proposal saved in DealSaathi only.',
  booking: 'Booking in progress…',
  booked: 'Booked: Google Calendar returned an event id.',
  booking_unverified: 'Google Calendar answered without an event id, so the booking is not confirmed. Check the calendar before retrying, or it may be booked twice.',
  booking_failed: 'Booking failed. Nothing was confirmed on the calendar.',
  cancelled: 'Cancelled in DealSaathi. A calendar event, if one was booked, is not removed automatically.',
  completed: 'Marked as completed.'
}

function availabilityLine(availability) {
  if (!availability) return h('p', { class: 'small muted' }, 'Calendar availability not checked.')
  if (!availability.checked) return h('p', { class: 'small', style: { color: 'var(--warn)' } }, availability.message)
  return h('p', { class: 'small', style: { color: availability.free ? 'var(--ok)' : 'var(--danger)' } },
    `${availability.message} (checked ${dateTime(availability.checked_at)})`,
    availability.conflicts?.length ? h('ul', { class: 'reasons' }, availability.conflicts.map((c) => h('li', {}, `${dateTime(c.start)} – ${dateTime(c.end)}`))) : null)
}

export function viewingCard(initial, { status, onChange } = {}) {
  let viewing = initial
  const card = h('div', { class: 'card stack' })
  const calendarReady = status.integrations.calendar

  function render() {
    const open = ['proposed', 'booking_failed', 'booking_unverified'].includes(viewing.status)
    const check = h('button', { class: 'small', disabled: !calendarReady, onclick: () => busy(check, run(`/viewings/${viewing.id}/availability`, 'viewing')) }, 'Check calendar availability')
    const book = h('button', { class: 'primary small', disabled: !calendarReady, onclick: async () => {
      const ok = await confirmDialog({
        title: 'Book this viewing on Google Calendar?',
        body: h('div', { class: 'stack tight' },
          h('p', {}, `${viewing.property_title || viewing.property_label} with ${viewing.lead_name}`),
          h('p', {}, `${date(viewing.start_date)} at ${viewing.start_time} (${viewing.time_zone}), ${viewing.duration_minutes} min`),
          h('p', { class: 'small muted' }, 'Google Calendar will invite the lead by email.'),
          viewing.status === 'booking_unverified' ? h('p', { class: 'field-error' }, 'An earlier attempt was not confirmed. Check your calendar first so you do not book it twice.') : null),
        confirmLabel: 'Book it'
      })
      if (ok) await busy(book, run(`/viewings/${viewing.id}/book`, 'viewing'))
    } }, 'Book on Google Calendar…')

    async function run(path, key, body) {
      try {
        const data = await api(path, { method: body ? 'PATCH' : 'POST', body })
        viewing = data[key]
        if (path.endsWith('/book')) toast(data.confirmed ? 'Booked on Google Calendar.' : 'Calendar did not confirm the booking.', data.confirmed ? 'info' : 'error')
        onChange?.()
      } catch (e) {
        toast(errorText(e), 'error')
        viewing = (await api('/viewings')).viewings.find((v) => v.id === viewing.id) || viewing
      }
      render()
    }

    mount(card,
      h('div', { class: 'row between' },
        h('div', { class: 'row' }, h('h3', {}, viewing.property_title || viewing.property_label), viewing.property_is_sample ? sampleBadge() : null),
        statusBadge(viewing.status)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Lead'), h('dd', {}, viewing.lead_name),
        h('dt', {}, 'When'), h('dd', {}, `${date(viewing.start_date)} at ${viewing.start_time} · ${viewing.duration_minutes} min · ${viewing.time_zone}`),
        h('dt', {}, 'Where'), h('dd', {}, viewing.location || '—'),
        h('dt', {}, 'Broker'), h('dd', {}, viewing.broker || '—'),
        viewing.notes ? [h('dt', {}, 'Notes'), h('dd', {}, viewing.notes)] : null),
      h('p', { class: 'small muted' }, BOOKING_TEXT[viewing.status]),
      open ? availabilityLine(viewing.availability) : null,
      viewing.calendar_event_id ? h('p', { class: 'small muted' }, 'Calendar event id: ', h('span', { class: 'mono' }, viewing.calendar_event_id)) : null,
      open
        ? h('div', { class: 'row' }, check, book,
            h('button', { class: 'small ghost', onclick: () => run(`/viewings/${viewing.id}/status`, 'viewing', { status: 'cancelled' }) }, 'Cancel'),
            calendarReady ? null : h('span', { class: 'small muted' }, 'Connect Google Calendar and choose a calendar in Integrations to check and book.'))
        : viewing.status === 'booked'
          ? h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => run(`/viewings/${viewing.id}/status`, 'viewing', { status: 'completed' }) }, 'Mark completed'))
          : null
    )
  }
  render()
  return card
}

async function viewingForm(status, { onSaved }) {
  const [{ leads }, { properties }] = await Promise.all([api('/leads?limit=500'), api('/properties')])
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Save proposal')
  const notice = h('div')
  const form = h('form', { class: 'form-grid', novalidate: true },
    field('Lead *', select('lead_id', [['', leads.length ? 'Choose a lead…' : 'Add a lead first'], ...leads.map((l) => [l.id, `${l.full_name}${l.is_sample ? ' (sample)' : ''}`])], '')),
    field('Property', select('property_id', [['', 'Not in the list'], ...properties.map((p) => [p.id, `${p.title}${p.is_sample ? ' (sample)' : ''}`])], '')),
    field('Or describe the property', h('input', { name: 'property_label', placeholder: 'Flat 302, Green Valley, Baner' }), { full: true }),
    field('Date *', h('input', { name: 'start_date', type: 'date', min: status.today })),
    field('Time *', h('input', { name: 'start_time', type: 'time' })),
    field('Duration (minutes)', h('input', { name: 'duration_minutes', type: 'number', min: 15, max: 240, value: 60 })),
    field('Time zone', select('time_zone', status.timeZones, status.timeZone)),
    field('Broker', h('input', { name: 'broker' })),
    field('Meeting point', h('input', { name: 'location', placeholder: 'Defaults to the property address' })),
    field('Notes', h('textarea', { name: 'notes', rows: 2 }), { full: true }),
    h('div', { class: 'full' }, notice),
    h('div', { class: 'full row' }, submit, h('span', { class: 'small muted' }, 'Saving does not book anything. You can check the calendar and book afterwards.'))
  )
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const data = formData(form)
    mount(notice)
    busy(submit, (async () => {
      try {
        const { viewing } = await api('/viewings', { method: 'POST', body: data })
        toast('Viewing proposal saved (not booked).')
        onSaved(viewing)
      } catch (e) {
        showIssues(form, e.data?.issues)
        mount(notice, h('div', { class: 'banner danger' }, errorText(e)))
      }
    })())
  })
  return form
}

export async function renderViewings(container, ctx) {
  const status = ctx.status
  const list = h('div', { class: 'stack' })
  async function load() {
    const { viewings } = await api('/viewings')
    const upcoming = viewings.filter((v) => v.start_date >= status.today && !['cancelled', 'completed'].includes(v.status))
    const past = viewings.filter((v) => !upcoming.includes(v))
    mount(list,
      h('h2', {}, 'Upcoming'),
      upcoming.length ? h('div', { class: 'grid cols-2' }, upcoming.map((v) => viewingCard(v, { status, onChange: load }))) : h('div', { class: 'empty' }, 'No upcoming viewings.'),
      past.length ? [h('h2', { style: { marginTop: '10px' } }, 'Past and closed'), h('div', { class: 'grid cols-2' }, past.map((v) => viewingCard(v, { status, onChange: load })))] : null)
  }
  const prepare = async () => {
    const drawer = openDrawer(h('p', { class: 'muted' }, 'Loading…'))
    drawer.render(h('div', { class: 'stack' }, h('h1', {}, 'Prepare a viewing'), await viewingForm(status, { onSaved: () => { drawer.close(); load() } })))
  }
  mount(container,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Property viewings'), h('p', { class: 'muted' }, 'Proposals stay unbooked until Google Calendar confirms the event.')),
      h('div', { class: 'row' }, status.integrations.calendar ? badge('Google Calendar connected', 'ok') : badge('No calendar connected', 'warn'),
        h('button', { class: 'primary', onclick: prepare }, '+ Prepare viewing'))),
    status.viasocket.configured ? null : notConfiguredBanner('Viewings can be prepared, but not checked against or booked on a calendar.'),
    list)
  await load()
}

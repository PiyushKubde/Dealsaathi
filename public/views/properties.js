import { api, badge, busy, errorText, field, formData, h, humanize, inr, mount, openDrawer, sampleBadge, select, showIssues, toast } from '../lib.js'
import { sampleBanner } from './shared.js'

export function propertyResultCard({ property, reasons, gaps }) {
  const toggle = h('button', { class: 'small ghost' }, 'Details')
  const details = h('dl', { class: 'kv small', hidden: true },
    h('dt', {}, 'Address'), h('dd', {}, property.address || '—'),
    h('dt', {}, 'Area'), h('dd', {}, property.area_sqft ? `${property.area_sqft} sq ft` : 'not recorded'),
    h('dt', {}, 'Amenities'), h('dd', {}, property.amenities.length ? property.amenities.join(', ') : 'none listed'),
    h('dt', {}, 'Description'), h('dd', {}, property.description || '—'),
    h('dt', {}, 'Listing id'), h('dd', {}, `#${property.id}`))
  toggle.onclick = () => { details.hidden = !details.hidden; toggle.textContent = details.hidden ? 'Details' : 'Hide details' }
  return h('div', { class: 'card property-card' },
    h('div', { class: 'row between' },
      h('div', { class: 'row' }, property.is_sample ? sampleBadge() : badge('Your listing', 'primary'), badge(property.listing_type === 'rent' ? 'For rent' : 'For sale')),
      h('span', { class: 'price' }, inr(property.price), property.listing_type === 'rent' ? h('span', { class: 'small muted' }, ' / month') : null)),
    h('h3', {}, property.title),
    h('p', { class: 'small muted' }, [property.locality, property.city].filter(Boolean).join(', '), ' · ', humanize(property.property_type),
      property.bedrooms != null ? ` · ${property.bedrooms} BHK` : ''),
    reasons?.length || gaps?.length
      ? h('ul', { class: 'reasons' }, (reasons || []).map((r) => h('li', {}, `✓ ${r}`)), (gaps || []).map((g) => h('li', { class: 'gap' }, `△ ${g}`)))
      : null,
    h('div', {}, toggle), details)
}

function propertyForm({ onSaved }) {
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Add listing')
  const notice = h('div')
  const form = h('form', { class: 'form-grid', novalidate: true },
    field('Title *', h('input', { name: 'title', placeholder: '2BHK in Baner, 2nd floor' }), { full: true }),
    field('Listing type *', select('listing_type', [['sale', 'For sale'], ['rent', 'For rent']], 'sale')),
    field('Property type *', select('property_type', ['apartment', 'villa', 'independent house', 'plot', 'commercial'], 'apartment')),
    field('City *', h('input', { name: 'city' })),
    field('Locality', h('input', { name: 'locality' })),
    field('Address', h('input', { name: 'address' }), { full: true }),
    field('Price (₹) *', h('input', { name: 'price', type: 'number', min: 1 }), { hint: 'Sale price, or monthly rent.' }),
    field('Bedrooms', h('input', { name: 'bedrooms', type: 'number', min: 0 })),
    field('Area (sq ft)', h('input', { name: 'area_sqft', type: 'number', min: 0 })),
    field('Amenities', h('input', { name: 'amenities', placeholder: 'parking, gym, lift' }), { hint: 'Comma separated.' }),
    field('Description', h('textarea', { name: 'description', rows: 3 }), { full: true }),
    h('div', { class: 'full' }, notice),
    h('div', { class: 'full' }, submit))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const data = formData(form)
    data.amenities = (data.amenities || '').split(',').map((a) => a.trim()).filter(Boolean)
    mount(notice)
    busy(submit, (async () => {
      try {
        await api('/properties', { method: 'POST', body: data })
        toast('Listing added.')
        onSaved()
      } catch (e) {
        showIssues(form, e.data?.issues)
        mount(notice, h('div', { class: 'banner danger' }, errorText(e)))
      }
    })())
  })
  return form
}

export async function renderProperties(container, ctx) {
  const results = h('div', { class: 'stack' })
  const inventory = h('div')
  const includeSample = h('input', { type: 'checkbox', name: 'include_sample', checked: true })
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Find matches')
  const form = h('form', { class: 'form-grid' },
    field('City', h('input', { name: 'city', placeholder: 'Pune' })),
    field('Locality', h('input', { name: 'locality', placeholder: 'Baner' })),
    field('Buy or rent', select('listing_type', [['', 'Either'], ['sale', 'Buy'], ['rent', 'Rent']], '')),
    field('Property type', select('property_type', [['', 'Any'], 'apartment', 'villa', 'independent house', 'plot', 'commercial'], '')),
    field('Min budget (₹)', h('input', { name: 'budget_min', type: 'number', min: 0 })),
    field('Max budget (₹)', h('input', { name: 'budget_max', type: 'number', min: 0, placeholder: '5000000 for ₹50 L' })),
    field('Bedrooms', h('input', { name: 'bedrooms', type: 'number', min: 0, max: 20 })),
    field('Amenities', h('input', { name: 'amenities', placeholder: 'parking, gym' })),
    h('label', { class: 'full check' }, includeSample, 'Include sample listings'),
    h('div', { class: 'full' }, submit))

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const data = formData(form)
    const body = {
      ...data,
      amenities: (data.amenities || '').split(',').map((a) => a.trim()).filter(Boolean),
      budget_min: data.budget_min === null ? null : Number(data.budget_min),
      budget_max: data.budget_max === null ? null : Number(data.budget_max),
      bedrooms: data.bedrooms === null ? null : Number(data.bedrooms)
    }
    busy(submit, (async () => {
      try {
        const match = await api('/properties/match', { method: 'POST', body })
        const samples = match.results.filter((r) => r.property.is_sample).length
        mount(results,
          h('div', { class: 'row between' }, h('h2', {}, `${match.results.length} match${match.results.length === 1 ? '' : 'es'}`), h('span', { class: 'small muted' }, `${match.searched} listings searched`)),
          samples ? sampleBanner(`${samples} of these results are sample listings for demonstration. They are not live market inventory.`) : null,
          match.results.length ? h('div', { class: 'grid cols-2' }, match.results.map(propertyResultCard)) : h('div', { class: 'empty' }, 'No stored listing meets these requirements.'))
      } catch (e) {
        toast(errorText(e), 'error')
      }
    })())
  })

  async function loadInventory() {
    const { properties } = await api('/properties')
    const own = properties.filter((p) => !p.is_sample)
    mount(inventory,
      h('p', { class: 'small muted', style: { marginBottom: '10px' } }, `${own.length} of your own listings · ${properties.length - own.length} sample listings`),
      properties.length ? h('div', { class: 'grid cols-2' }, properties.map((p) => propertyResultCard({ property: p }))) : h('div', { class: 'empty' }, 'No listings yet.'))
  }

  const add = () => {
    const drawer = openDrawer(h('div', { class: 'stack' }, h('h1', {}, 'Add a listing'), propertyForm({ onSaved: () => { drawer.close(); loadInventory() } })))
  }

  mount(container,
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, 'Property matching'), h('p', { class: 'muted' }, 'Match a client’s requirements against the listings stored in DealSaathi.')),
      h('div', { class: 'row' }, h('button', { onclick: () => ctx.navigate('assistant') }, 'Ask the assistant'), h('button', { class: 'primary', onclick: add }, '+ Add listing'))),
    ctx.status.data.properties.sample
      ? sampleBanner('No live listing feed is connected. DealSaathi includes a few sample listings, marked “Sample”, so matching can be demonstrated. Add your own listings to match against real inventory.')
      : null,
    h('div', { class: 'card', style: { marginBottom: '16px' } }, h('h2', { style: { marginBottom: '12px' } }, 'Requirements'), form),
    results,
    h('div', { class: 'card', style: { marginTop: '16px' } }, h('h2', { style: { marginBottom: '6px' } }, 'All listings'), inventory))
  await loadInventory()
}

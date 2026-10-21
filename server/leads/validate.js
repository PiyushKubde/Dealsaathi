// Lead field rules, shared by the form API and the assistant.
export const CUSTOMER_TYPES = ['buyer', 'seller', 'tenant', 'landlord']
export const STATUSES = ['new', 'contacted', 'qualified', 'viewing_scheduled', 'negotiating', 'won', 'lost']
export const SOURCES = ['walk_in', 'referral', 'website', 'phone_call', 'social_media', 'property_portal', 'other']
export const PROPERTY_TYPES = ['apartment', 'independent_house', 'villa', 'plot', 'commercial', 'other']

/** Every field a caller may set, in display order. */
export const LEAD_FIELDS = [
  'full_name', 'email', 'phone', 'source', 'customer_type', 'property_type', 'property_interest',
  'bedrooms', 'preferred_location', 'budget_min', 'budget_max', 'status', 'assigned_broker', 'notes', 'follow_up_on'
]

const TEXT_LIMITS = { full_name: 100, property_interest: 200, preferred_location: 120, assigned_broker: 100, notes: 2000 }
const ENUMS = { customer_type: CUSTOMER_TYPES, status: STATUSES, source: SOURCES, property_type: PROPERTY_TYPES }
const MAX_BUDGET = 100_000_000_000 // ₹10,000 crore: anything above is a typo

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function normalizeEmail(email) {
  return email ? email.trim().toLowerCase() : null
}

/** Digits only; an Indian number with +91 or a leading 0 is reduced to its 10 digits. */
export function normalizePhone(phone) {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  return digits
}

export const normalizeName = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * Checks and cleans the given fields. Unknown keys are ignored; a key set to '' or null clears it.
 * Returns { value, errors } where errors maps field → message.
 */
export function cleanLeadFields(input) {
  const value = {}
  const errors = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value, errors: { _: 'Expected an object.' } }

  for (const field of LEAD_FIELDS) {
    if (!(field in input)) continue
    let raw = input[field]
    if (raw === undefined) continue
    if (typeof raw === 'string') raw = raw.trim()
    if (raw === '' || raw === null) {
      value[field] = null
      continue
    }

    if (field === 'bedrooms' || field === 'budget_min' || field === 'budget_max') {
      const n = typeof raw === 'string' ? Number(raw.replace(/,/g, '')) : raw
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) errors[field] = 'Must be a whole number, 0 or more.'
      else if (field === 'bedrooms' && n > 20) errors[field] = 'Must be 20 or fewer.'
      else if (field !== 'bedrooms' && n > MAX_BUDGET) errors[field] = 'That amount looks too large.'
      else value[field] = n
      continue
    }

    if (typeof raw !== 'string') {
      errors[field] = 'Must be text.'
      continue
    }
    if (ENUMS[field]) {
      if (!ENUMS[field].includes(raw)) errors[field] = `Must be one of: ${ENUMS[field].join(', ')}.`
      else value[field] = raw
      continue
    }
    if (field === 'email') {
      if (raw.length > 200 || !EMAIL_RE.test(raw)) errors.email = 'Enter a valid email address.'
      else value.email = raw
      continue
    }
    if (field === 'follow_up_on') {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : null
      if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) errors.follow_up_on = 'Use a real date (YYYY-MM-DD).'
      else value.follow_up_on = raw
      continue
    }
    if (field === 'phone') {
      const digits = raw.replace(/\D/g, '')
      if (!/^[+\d\s\-().]+$/.test(raw) || digits.length < 10 || digits.length > 15) errors.phone = 'Enter a valid phone number (10–15 digits).'
      else value.phone = raw
      continue
    }
    const text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    if (text.length > TEXT_LIMITS[field]) errors[field] = `Must be ${TEXT_LIMITS[field]} characters or fewer.`
    else if (field === 'full_name' && text.length < 2) errors.full_name = 'Enter the full name.'
    else value[field] = text
  }
  return { value, errors }
}

/** Rules a complete lead must meet, checked on the merged record. */
export function checkCompleteLead(lead) {
  const errors = {}
  if (!lead.full_name) errors.full_name = 'Full name is required.'
  if (!lead.customer_type) errors.customer_type = 'Customer type is required (buyer, seller, tenant or landlord).'
  if (!lead.email && !lead.phone) errors.phone = 'Add a phone number or an email address.'
  if (lead.budget_min != null && lead.budget_max != null && lead.budget_min > lead.budget_max) {
    errors.budget_min = 'Minimum budget is above the maximum.'
  }
  return errors
}

/** What a broker still has to supply before a lead can be saved. */
export function missingForCreate(draft) {
  const missing = []
  if (!draft.full_name) missing.push('full_name')
  if (!draft.customer_type) missing.push('customer_type')
  if (!draft.email && !draft.phone) missing.push('phone_or_email')
  return missing
}

export const leadCode = (id) => `L-${String(id).padStart(4, '0')}`

/** "L-0007", "l7", "7" → 7; anything else → null. */
export function parseLeadCode(text) {
  const m = /^\s*(?:l-?)?0*(\d{1,9})\s*$/i.exec(String(text || ''))
  return m ? Number(m[1]) : null
}

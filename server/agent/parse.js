// Deterministic reading of a buyer's words: budget amounts in Indian units, bedrooms, buy or rent, property type
// and the place named after "near"/"in". The model proposes search criteria; numbers it proposes are checked
// against these, so "₹50 lakh" can never silently become a different budget.

const UNIT = { rupees: 1, thousand: 1e3, lakh: 1e5, crore: 1e7 }
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }

/** "lakh", "lacs", "L", "cr", "k" … → a unit key, else null. */
export function unitOf(word) {
  const w = String(word || '').toLowerCase().replace(/\.$/, '')
  if (/^(lakh|lakhs|lac|lacs|l)$/.test(w)) return 'lakh'
  if (/^(crore|crores|cr|crs)$/.test(w)) return 'crore'
  if (/^(k|thousand)$/.test(w)) return 'thousand'
  return null
}

/** An amount in rupees from a number and a unit; null when it would be nonsense. */
export function toRupees(amount, unit) {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0 || !(unit in UNIT)) return null
  const value = Math.round(n * UNIT[unit])
  return value >= 1000 && value <= 1e10 ? value : null
}

const MONEY = String.raw`(?:rs\.?|inr|₹)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|l|crores?|crs?|cr|k|thousand)?\b`

function money(numText, unitWord) {
  const unit = unitOf(unitWord)
  const n = Number(String(numText).replace(/,/g, ''))
  if (unit) return toRupees(n, unit)
  // A bare number counts only when it is plainly rupees (48,00,000 or 4800000); "50" alone is ambiguous.
  return n >= 100000 ? toRupees(n, 'rupees') : null
}

/** Reads what a message states. Every key is null when the message does not say it. */
export function parseRequest(text) {
  const s = String(text || '').replace(/\s+/g, ' ')
  const lower = s.toLowerCase()
  const out = { bedrooms: null, budget_max: null, budget_min: null, listing_type: null, property_type: null, location: null, ambiguous_budget: false, cleared: [] }

  const bhk = lower.match(/\b(\d)\s*-?\s*(?:bhk|rk|bed(?:room)?s?)\b/) || lower.match(/\b(one|two|three|four|five|six)\s*-?\s*(?:bhk|bed(?:room)?s?)\b/)
  if (bhk) out.bedrooms = Number(bhk[1]) || WORD_NUM[bhk[1]] || null

  const range = lower.match(new RegExp(String.raw`(?:rs\.?|inr|₹)?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:-|to)\s*` + MONEY))
  if (range && unitOf(range[3])) {
    out.budget_min = money(range[1], range[3])
    out.budget_max = money(range[2], range[3])
  }
  const max = lower.match(new RegExp(String.raw`\b(?:under|below|upto|up to|within|max(?:imum)?|less than|not more than|budget(?: of| is)?)\s*` + MONEY))
  if (max && out.budget_max == null) {
    out.budget_max = money(max[1], max[2])
    if (out.budget_max == null) out.ambiguous_budget = true
  }
  const trailing = lower.match(new RegExp(MONEY + String.raw`\s*(?:budget|max(?:imum)?)\b`))
  if (trailing && out.budget_max == null && unitOf(trailing[2])) out.budget_max = money(trailing[1], trailing[2])
  const min = lower.match(new RegExp(String.raw`\b(?:above|over|more than|at least|min(?:imum)?|from)\s*` + MONEY))
  if (min && out.budget_min == null && unitOf(min[2])) out.budget_min = money(min[1], min[2])

  if (/\b(rent|rental|renting|lease|on rent|per month|monthly rent)\b/.test(lower)) out.listing_type = 'rent'
  else if (/\b(buy|buying|purchase|for sale|to own)\b/.test(lower)) out.listing_type = 'sale'

  // One property type only when exactly one is named ("a flat or a house" states none).
  const types = [[/\b(apartment|flat)s?\b/, 'apartment'], [/\bvillas?\b/, 'villa'], [/\b(independent house|house|bungalow)s?\b/, 'independent_house'], [/\b(plot|land)s?\b/, 'plot']]
    .filter(([re]) => re.test(lower)).map(([, t]) => t)
  if (types.length === 1) out.property_type = types[0]

  // A requirement the buyer explicitly lifts ("any number of bedrooms", "budget doesn't matter").
  if (/\bany (?:number of )?(?:bhk|bed(?:room)?s?)\b|\b(?:bhk|bedrooms?) (?:doesn'?t|does not|don'?t|do not) matter\b/.test(lower)) out.cleared.push('bedrooms')
  if (/\b(?:any|no) (?:budget|price)\b|\b(?:budget|price) (?:doesn'?t|does not) matter\b/.test(lower)) out.cleared.push('budget_max', 'budget_min')
  if (/\bany (?:property )?type\b|\b(?:type|kind) (?:doesn'?t|does not) matter\b/.test(lower) || types.length > 1) out.cleared.push('property_type')

  // "near Vijay Nagar", "in Indore": capitalised place words after the preposition, up to the next clause.
  const places = []
  const re = /\b(?:near|in|at|around|close to|nearby)\s+((?:[A-Z][A-Za-z.'-]*)(?:\s+[A-Z][A-Za-z.'-]*){0,3})/g
  let m
  while ((m = re.exec(s))) {
    const place = m[1].replace(/\b(BHK|Rs|INR)\b.*$/i, '').trim()
    if (place && !/^(I|Indian|My|The|A|An)$/.test(place)) places.push(place)
  }
  if (places.length) out.location = [...new Set(places)].join(', ').slice(0, 80)
  return out
}

/** ₹50 L / ₹1.2 Cr / ₹25,000: how DealSaathi writes amounts. */
export const inr = (n) => (n >= 1e7 ? `₹${+(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${+(n / 1e5).toFixed(2)} L` : `₹${Number(n).toLocaleString('en-IN')}`)

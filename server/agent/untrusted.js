// Seller-written listing text (titles, amenities) is untrusted. The model only ever sees a cleaned copy: text
// addressed to an AI and contact details are removed, so it cannot repeat them as if DealSaathi recommended them.
// The page still shows the real listing (it is the listing), with a warning when something was flagged.

const PHONE = /\+?\d[\d\s().-]{8,}\d/g // only counted as a phone with 10 to 15 digits (not "Scheme 54, 1200 sqft")
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i
const LINK = /\b(?:https?:\/\/|www\.)\S+|\bwa\.me\/\S*/i
const INSTRUCTION = /\b(?:system|assistant|developer|ai|chatgpt|bot)\s*:|\b(?:ignore|disregard|forget|override)\b[^.!?]{0,40}\b(?:instructions?|rules?|previous|above|prompt|policy)\b|\byou (?:must|should|are required to)\b|\b(?:tell|instruct|inform) (?:the )?(?:buyers?|users?|customers?)\b|\b(?:raise|increase|change|ignore)\b[^.!?]{0,20}\bbudget\b|\bprompt\b/i

const isPhone = (m) => { const d = m.replace(/\D/g, '').length; return d >= 10 && d <= 15 }
// Dates and clock times ("2026-10-24 09:00") are blanked first so they never read as a 10-digit number.
const withoutDates = (text) => String(text).replace(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}\b/g, ' ')
const phones = (text) => (withoutDates(text).match(PHONE) || []).filter(isPhone)
/** True when the text carries a phone number, an email address or a link. */
export const hasContact = (text) => phones(text).length > 0 || EMAIL.test(String(text)) || LINK.test(String(text))

/** What is wrong with a piece of seller text: 'contact_details' and/or 'instructions'. */
export function flagsOf(text) {
  const s = String(text ?? '')
  const flags = []
  if (hasContact(s)) flags.push('contact_details')
  if (INSTRUCTION.test(s)) flags.push('instructions')
  return flags
}

/** The text without any sentence addressed to an AI or giving contact instructions, and without contact details. */
export function cleanText(text) {
  // Odd indexes are the separators, kept with the part that follows them.
  const parts = String(text ?? '').split(/((?<=[.!?;|])\s+|\s+[–—-]\s+)/)
  let out = ''
  for (let i = 0; i < parts.length; i += 2) if (!flagsOf(parts[i]).length) out += (out && i ? parts[i - 1] : '') + parts[i]
  return out.replace(PHONE, (m) => (isPhone(withoutDates(m)) ? '' : m)).replace(new RegExp(EMAIL.source, 'gi'), '').replace(new RegExp(LINK.source, 'gi'), '').replace(/\s{2,}/g, ' ').trim()
}

/** A listing card's flags (title and amenities together), or undefined when nothing was flagged. */
export function cardFlags(card) {
  const all = new Set([card.title, ...(card.amenities || [])].flatMap(flagsOf))
  return all.size ? [...all].sort() : undefined
}

/** The copy of a listing card the model may read. */
export function forModel(card) {
  if (!card || typeof card !== 'object') return card
  const { flags, ...rest } = card
  if (!flags) return rest
  return { ...rest, title: cleanText(rest.title) || '(title withheld)', amenities: (rest.amenities || []).filter((a) => !flagsOf(a).length), untrusted_text_removed: true }
}

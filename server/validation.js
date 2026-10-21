import { z } from 'zod'
import { CALENDAR_TIME_ZONES } from './viasocket.js'

export const LEAD_CATEGORIES = ['buyer', 'seller', 'tenant', 'landlord']
export const LEAD_STATUSES = ['new', 'contacted', 'interested', 'viewing_scheduled', 'negotiating', 'won', 'lost']
export const PAYMENT_STATUSES = ['unpaid', 'partial', 'paid', 'unknown']

const trimmed = (max) => z.string().trim().max(max)
const optionalText = (max) =>
  z
    .union([trimmed(max), z.null()])
    .optional()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value))

const money = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === null || value === '') return null
    const number = typeof value === 'number' ? value : Number(String(value).replace(/[,\s₹]/g, ''))
    if (!Number.isFinite(number) || number < 0 || number > 1e12) {
      ctx.addIssue({ code: 'custom', message: 'must be a positive amount in rupees' })
      return z.NEVER
    }
    return Math.round(number)
  })

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  }, 'is not a real calendar date')

const email = z
  .union([z.string().trim().toLowerCase().email('must be a valid email address').max(254), z.literal(''), z.null()])
  .optional()
  .transform((value) => value || null)

const phone = z
  .union([z.string().trim().max(32), z.null()])
  .optional()
  .transform((value, ctx) => {
    if (!value) return null
    const digits = value.replace(/\D/g, '')
    if (digits.length < 7 || digits.length > 15) {
      ctx.addIssue({ code: 'custom', message: 'must be a phone number with 7 to 15 digits' })
      return z.NEVER
    }
    return value
  })

const leadFields = {
  full_name: trimmed(120).min(2, 'is required'),
  email,
  phone,
  source: optionalText(80),
  category: z.enum(LEAD_CATEGORIES, { message: `must be one of ${LEAD_CATEGORIES.join(', ')}` }),
  property_interest: optionalText(200),
  preferred_location: optionalText(120),
  budget_min: money,
  budget_max: money,
  status: z.enum(LEAD_STATUSES).optional().default('new'),
  assigned_broker: optionalText(120),
  notes: optionalText(2000)
}

function budgetOrder(lead, ctx) {
  if (lead.budget_min != null && lead.budget_max != null && lead.budget_min > lead.budget_max) {
    ctx.addIssue({ code: 'custom', path: ['budget_min'], message: 'cannot be greater than the maximum budget' })
  }
}

export const leadCreateSchema = z
  .object(leadFields)
  .superRefine((lead, ctx) => {
    if (!lead.email && !lead.phone) {
      ctx.addIssue({ code: 'custom', path: ['email'], message: 'an email address or a phone number is required' })
    }
    budgetOrder(lead, ctx)
  })

/**
 * Validates a new lead. The contact rule is checked separately because an object-level refinement is skipped
 * whenever another field already failed, which would hide "email or phone is required" behind other errors.
 */
export function validateLeadCreate(input) {
  const raw = input ?? {}
  const result = leadCreateSchema.safeParse(raw)
  if (result.success) return result.data
  const issues = result.error.issues.map((issue) => ({ field: issue.path.join('.') || null, message: issue.message }))
  const blank = (value) => value === undefined || value === null || String(value).trim() === ''
  if (blank(raw.email) && blank(raw.phone) && !issues.some((i) => i.field === 'email' || i.field === 'phone')) {
    issues.push({ field: 'email', message: 'an email address or a phone number is required' })
  }
  throw new ValidationError(issues)
}

export const leadUpdateSchema = z
  .object(Object.fromEntries(Object.entries(leadFields).map(([key, schema]) => [key, schema.optional()])))
  .superRefine(budgetOrder)

export const propertySchema = z.object({
  title: trimmed(160).min(3, 'is required'),
  listing_type: z.enum(['sale', 'rent']),
  property_type: trimmed(40).min(2, 'is required'),
  city: trimmed(80).min(2, 'is required'),
  locality: optionalText(120),
  address: optionalText(300),
  price: money.refine((value) => value != null && value > 0, 'is required'),
  bedrooms: z.coerce.number().int().min(0).max(20).nullable().optional().default(null),
  area_sqft: z.coerce.number().int().min(0).max(1_000_000).nullable().optional().default(null),
  amenities: z.array(trimmed(40)).max(30).optional().default([]),
  available: z.boolean().optional().default(true),
  description: optionalText(2000)
})

export const viewingSchema = z.object({
  lead_id: z.coerce.number().int().positive('is required'),
  property_id: z.coerce.number().int().positive().nullable().optional().default(null),
  property_label: optionalText(200),
  start_date: isoDate,
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a 24-hour time like 16:00'),
  duration_minutes: z.coerce.number().int().min(15).max(240).optional().default(60),
  time_zone: z.enum(CALENDAR_TIME_ZONES, { message: 'must be a time zone Google Calendar accepts' }),
  broker: optionalText(120),
  location: optionalText(300),
  notes: optionalText(1000)
}).superRefine((viewing, ctx) => {
  if (!viewing.property_id && !viewing.property_label) {
    ctx.addIssue({ code: 'custom', path: ['property_id'], message: 'choose a property or describe it' })
  }
})

export const rentSchema = z.object({
  tenant_name: trimmed(120).min(2, 'is required'),
  tenant_email: email,
  tenant_phone: phone,
  property_id: z.coerce.number().int().positive().nullable().optional().default(null),
  property_label: trimmed(200).min(2, 'is required'),
  amount: money.refine((value) => value != null && value > 0, 'is required'),
  due_date: isoDate,
  payment_status: z.enum(PAYMENT_STATUSES).optional().default('unknown'),
  last_payment_date: z.union([isoDate, z.literal(''), z.null()]).optional().transform((value) => value || null),
  last_payment_amount: money,
  notes: optionalText(1000)
})

export const messageDraftSchema = z.object({
  subject: trimmed(200).min(1, 'is required'),
  body: trimmed(10_000).min(1, 'is required')
})

export class ValidationError extends Error {
  constructor(issues) {
    super('Some details need fixing.')
    this.status = 422
    this.issues = issues
  }
}

/** Parses with a schema and throws a ValidationError listing each field's problem in plain words. */
export function parseOrThrow(schema, input) {
  const result = schema.safeParse(input ?? {})
  if (result.success) return result.data
  throw new ValidationError(
    result.error.issues.map((issue) => ({ field: issue.path.join('.') || null, message: issue.message }))
  )
}

export function normalizeEmail(value) {
  return value ? value.trim().toLowerCase() : null
}

/** Digits only, with an Indian +91 / leading 0 prefix folded so 098765 43210 and +91 98765 43210 match. */
export function normalizePhone(value) {
  if (!value) return null
  let digits = value.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  return digits
}

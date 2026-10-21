import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanLeadFields, checkCompleteLead, missingForCreate, normalizePhone, parseLeadCode, leadCode } from '../server/leads/validate.js'

test('cleanLeadFields keeps valid values and trims text', () => {
  const { value, errors } = cleanLeadFields({ full_name: '  Rahul Sharma ', customer_type: 'buyer', bedrooms: '2', budget_max: '5,000,000', email: 'r@x.in' })
  assert.deepEqual(errors, {})
  assert.deepEqual(value, { full_name: 'Rahul Sharma', customer_type: 'buyer', bedrooms: 2, budget_max: 5000000, email: 'r@x.in' })
})

test('cleanLeadFields rejects bad values field by field', () => {
  const { errors } = cleanLeadFields({ customer_type: 'investor', email: 'not-an-email', phone: '12ab', bedrooms: -1, budget_max: 1.5, status: 'hot', full_name: 'R' })
  assert.deepEqual(Object.keys(errors).sort(), ['bedrooms', 'budget_max', 'customer_type', 'email', 'full_name', 'phone', 'status'])
})

test('empty strings and null mean unknown; unknown keys are ignored', () => {
  const { value, errors } = cleanLeadFields({ email: '', phone: null, hacker_field: 'x' })
  assert.deepEqual(errors, {})
  assert.deepEqual(value, { email: null, phone: null })
})

test('non-object input is rejected', () => {
  assert.ok(cleanLeadFields(null).errors._)
  assert.ok(cleanLeadFields([1]).errors._)
})

test('a complete lead needs name, type and phone or email', () => {
  assert.deepEqual(Object.keys(checkCompleteLead({})).sort(), ['customer_type', 'full_name', 'phone'])
  assert.deepEqual(checkCompleteLead({ full_name: 'A B', customer_type: 'buyer', email: 'a@b.co' }), {})
  assert.ok(checkCompleteLead({ full_name: 'A B', customer_type: 'buyer', phone: '9876543210', budget_min: 10, budget_max: 5 }).budget_min)
  assert.deepEqual(missingForCreate({ full_name: 'A' }), ['customer_type', 'phone_or_email'])
})

test('Indian phone numbers normalise to 10 digits', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '9876543210')
  assert.equal(normalizePhone('098765-43210'), '9876543210')
  assert.equal(normalizePhone('(987) 654-3210'), '9876543210')
})

test('lead codes round-trip', () => {
  assert.equal(leadCode(7), 'L-0007')
  assert.equal(parseLeadCode('L-0007'), 7)
  assert.equal(parseLeadCode('nope'), null)
})

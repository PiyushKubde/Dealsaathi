import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchProperties } from '../server/services/properties.js'
import { classifyRent } from '../server/services/rent.js'

const p = (over) => ({ id: 1, title: 't', listing_type: 'sale', property_type: 'apartment', city: 'Pune', locality: 'Baner', address: null, price: 4800000, bedrooms: 2, amenities: ['parking'], available: true, is_sample: true, ...over })

test('hard requirements exclude, soft ones explain', () => {
  const results = matchProperties([
    p({ id: 1 }),
    p({ id: 2, city: 'Mumbai' }),
    p({ id: 3, price: 6000000 }),
    p({ id: 4, available: false }),
    p({ id: 5, bedrooms: null }),
    p({ id: 6, locality: 'Wakad', bedrooms: 3 })
  ], { city: 'pune', budget_max: 5000000, bedrooms: 2, locality: 'Baner', amenities: ['gym', 'parking'] })
  assert.deepEqual(results.map((r) => r.property.id), [1, 6])
  assert.ok(results[0].reasons.includes('Lists parking'))
  assert.ok(results[0].gaps.includes('gym is not listed for this property'))
  assert.ok(results[1].gaps.some((g) => g.startsWith('Not in Baner')))
})

test('rentals are flagged when the search did not say buy or rent', () => {
  const [result] = matchProperties([p({ listing_type: 'rent', price: 28000 })], { city: 'Pune' })
  assert.ok(result.gaps.includes('This is a rental: its price is monthly rent'))
})

test('rent classification never infers non-payment from missing data', () => {
  const today = '2026-10-21'
  assert.equal(classifyRent({ payment_status: 'unknown', due_date: '2026-10-01' }, today).bucket, 'needs_verification')
  assert.equal(classifyRent({ payment_status: 'unpaid', due_date: '2026-10-01' }, today).bucket, 'overdue')
  assert.equal(classifyRent({ payment_status: 'partial', due_date: '2026-10-25' }, today).bucket, 'due_soon')
  assert.equal(classifyRent({ payment_status: 'unpaid', due_date: '2026-11-30' }, today).bucket, 'later')
  assert.equal(classifyRent({ payment_status: 'paid', due_date: '2026-10-01' }, today).bucket, 'paid')
})

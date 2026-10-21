import { addDays } from './services/rent.js'

/**
 * Demonstration records. Every row is stored with is_sample = 1 and labelled "Sample" in the UI; none of it
 * is real inventory, a real person or a real payment. Contact details use the reserved example.com domain.
 */
export const SAMPLE_PROPERTIES = [
  { title: '2BHK in Baner near Balewadi High Street', listing_type: 'sale', property_type: 'apartment', city: 'Pune', locality: 'Baner', address: 'Sample listing, Baner, Pune', price: 4800000, bedrooms: 2, area_sqft: 980, amenities: ['parking', 'gym', 'lift', 'security'], description: 'Sample listing for demonstration only.' },
  { title: '2BHK in Wakad, ready to move', listing_type: 'sale', property_type: 'apartment', city: 'Pune', locality: 'Wakad', address: 'Sample listing, Wakad, Pune', price: 4500000, bedrooms: 2, area_sqft: 910, amenities: ['parking', 'lift', 'power backup'], description: 'Sample listing for demonstration only.' },
  { title: '3BHK in Kothrud with balcony', listing_type: 'sale', property_type: 'apartment', city: 'Pune', locality: 'Kothrud', address: 'Sample listing, Kothrud, Pune', price: 9200000, bedrooms: 3, area_sqft: 1450, amenities: ['parking', 'gym', 'swimming pool', 'clubhouse'], description: 'Sample listing for demonstration only.' },
  { title: '1BHK in Hinjewadi Phase 1', listing_type: 'sale', property_type: 'apartment', city: 'Pune', locality: 'Hinjewadi', address: 'Sample listing, Hinjewadi, Pune', price: 3200000, bedrooms: 1, area_sqft: 620, amenities: ['parking', 'security'], description: 'Sample listing for demonstration only.' },
  { title: '2BHK for rent in Viman Nagar', listing_type: 'rent', property_type: 'apartment', city: 'Pune', locality: 'Viman Nagar', address: 'Sample listing, Viman Nagar, Pune', price: 28000, bedrooms: 2, area_sqft: 1000, amenities: ['parking', 'furnished', 'lift'], description: 'Sample listing for demonstration only. Monthly rent.' },
  { title: '3BHK villa in Whitefield', listing_type: 'sale', property_type: 'villa', city: 'Bengaluru', locality: 'Whitefield', address: 'Sample listing, Whitefield, Bengaluru', price: 18500000, bedrooms: 3, area_sqft: 2200, amenities: ['garden', 'parking', 'security', 'clubhouse'], description: 'Sample listing for demonstration only.' },
  { title: '2BHK for rent in Andheri West', listing_type: 'rent', property_type: 'apartment', city: 'Mumbai', locality: 'Andheri West', address: 'Sample listing, Andheri West, Mumbai', price: 55000, bedrooms: 2, area_sqft: 750, amenities: ['lift', 'security', 'gym'], description: 'Sample listing for demonstration only. Monthly rent.' },
  { title: 'Office space in Kharadi', listing_type: 'rent', property_type: 'commercial', city: 'Pune', locality: 'Kharadi', address: 'Sample listing, Kharadi, Pune', price: 85000, bedrooms: null, area_sqft: 1800, amenities: ['parking', 'power backup', 'lift'], description: 'Sample listing for demonstration only. Monthly rent.' }
]

export const SAMPLE_LEADS = [
  { full_name: 'Sample Lead: Ananya Kulkarni', email: 'ananya.sample@example.com', phone: '+91 90000 00001', source: 'Website', category: 'buyer', property_interest: '2BHK apartment', preferred_location: 'Baner, Pune', budget_min: 4000000, budget_max: 5000000, status: 'interested', notes: 'Sample record for demonstration.' },
  { full_name: 'Sample Lead: Vikram Rao', email: 'vikram.sample@example.com', phone: '+91 90000 00002', source: 'Referral', category: 'tenant', property_interest: '2BHK on rent', preferred_location: 'Viman Nagar, Pune', budget_max: 30000, status: 'new', notes: 'Sample record for demonstration.' }
]

export function sampleRent(today) {
  return [
    { tenant_name: 'Sample Tenant: Meera Joshi', tenant_email: 'meera.sample@example.com', property_label: 'Sample: Flat 302, Viman Nagar', amount: 28000, due_date: addDays(today, 3), payment_status: 'unpaid', notes: 'Sample record for demonstration.' },
    { tenant_name: 'Sample Tenant: Arjun Mehta', tenant_email: 'arjun.sample@example.com', property_label: 'Sample: Shop 4, Kharadi', amount: 85000, due_date: addDays(today, -5), payment_status: 'unpaid', notes: 'Sample record for demonstration.' },
    { tenant_name: 'Sample Tenant: Priya Nair', tenant_email: 'priya.sample@example.com', property_label: 'Sample: Flat 11B, Andheri West', amount: 55000, due_date: addDays(today, 1), payment_status: 'unknown', notes: 'Sample record: payment status not recorded.' },
    { tenant_name: 'Sample Tenant: Kabir Singh', tenant_email: 'kabir.sample@example.com', property_label: 'Sample: Flat 7, Baner', amount: 22000, due_date: addDays(today, -2), payment_status: 'paid', last_payment_date: addDays(today, -3), last_payment_amount: 22000, notes: 'Sample record for demonstration.' }
  ]
}

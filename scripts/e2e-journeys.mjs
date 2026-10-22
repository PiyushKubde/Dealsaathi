// Browser journeys for the three roles, against the real app with a stand-in for viaSocket (no external sends).
//   node scripts/e2e-journeys.mjs [screenshot-dir]
// Needs Playwright (PLAYWRIGHT_MODULE=/path/to/node_modules, default: the global install). Exits 1 on any failure,
// console error, failed request, or horizontal scroll on a phone-width screen.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { startApp, fakeVs } from '../test/helpers.js'
import { addDays, todayIn } from '../server/time.js'

const require = createRequire(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/')
const { chromium } = require('playwright')
const SHOTS = process.argv[2] || null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const results = []
const problems = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) problems.push(`${name}${detail ? `: ${detail}` : ''}`) }

const vs = fakeVs()
const t = await startApp({ vs, withUser: false })
const B = t.base
const browser = await chromium.launch()

async function newPage(width = 1360) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`page error: ${e.message} @ ${page.url()} ${String(e.stack).split('\n').slice(1, 3).join(' ')}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/the server responded with a status of (4\d\d)/.test(m.text()) && !/ERR_TUNNEL_CONNECTION_FAILED/.test(m.text())) problems.push(`console: ${m.text()}`) }) // the stand-in's icon URLs are fake
  page.on('requestfailed', (r) => { if (!r.url().includes('viasocket') && !r.url().startsWith('https://icons.example/') && r.failure()?.errorText !== 'net::ERR_ABORTED') problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`) })
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()}: ${r.url()}`) })
  return page
}
/** Opens a page of the app; re-renders it when the browser is already on that address (same-hash navigation is a no-op). */
async function go(page, hash) {
  const same = page.url() === `${B}/${hash}`
  await page.goto(`${B}/${hash}`)
  if (same) await page.reload()
  await page.waitForSelector('main > *')
}
const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : null)
const idle = () => t.idle()

async function register(page, { role, name, email }) {
  await go(page, `#/dashboard`)
  await page.waitForSelector('#auth-form')
  if (await page.isVisible('#auth-switch') && !(await page.isVisible('#a-name'))) await page.click('#auth-switch')
  await page.click('#auth-form button[type=submit]') // nothing chosen: the form says so
  check(`${role}: signup without a role is refused`, /Choose Buyer, Seller or Agent/.test(await page.textContent('#auth-form')))
  await page.check(`input[name=role][value=${role}]`)
  await page.fill('#a-name', name)
  await page.fill('#a-email', email)
  await page.fill('#a-password', 'a-long-password-1')
  await page.click('#auth-form button[type=submit]')
  await page.waitForSelector('#nav a', { timeout: 15000 })
}

async function visitAllNav(page, role) {
  const links = await page.$$eval('#nav a', (as) => as.map((a) => a.getAttribute('href')))
  for (const href of links) {
    await go(page, href)
    await page.waitForTimeout(400)
    const text = await page.textContent('main')
    check(`${role}: ${href} renders`, !/Page not found|Something went wrong|Loading…$/.test(text.trim()) && !(await page.$('main > .notice.err')), text.trim().slice(0, 120))
  }
  return links
}

// ---- Agent: signs up, sets a service area, lists a property
const agentPage = await newPage()
await register(agentPage, { role: 'agent', name: 'Asha Broker', email: 'asha@agency.in' })
const agentNav = await visitAllNav(agentPage, 'agent')
check('agent: sees the agent sections', ['#/leads', '#/pool', '#/automations', '#/activity'].every((h) => agentNav.includes(h)), agentNav.join(' '))
await go(agentPage, `#/profile`)
await agentPage.fill('#pr-areas', 'Pune, Baner')
await agentPage.click('#pr-form button[type=submit]')
await agentPage.waitForTimeout(400)
await go(agentPage, `#/properties/new`)
await agentPage.waitForSelector('#p-form')
await agentPage.click('#p-save')
await agentPage.waitForSelector('#p-form .field.invalid')
check('agent: listing form shows field errors', (await agentPage.$$('#p-form .field.invalid')).length >= 4)
await agentPage.fill('[name=title]', '2 BHK in Baner')
await agentPage.selectOption('[name=listing_type]', 'sale')
await agentPage.selectOption('[name=property_type]', 'apartment')
await agentPage.fill('[name=price]', '4800000')
await agentPage.fill('[name=bedrooms]', '2')
await agentPage.fill('[name=city]', 'Pune')
await agentPage.fill('[name=locality]', 'Baner')
await agentPage.fill('[name=address]', '12 Baner Road')
await agentPage.click('#p-save')
await agentPage.waitForURL(/#\/properties\/\d+$/)
await agentPage.waitForSelector('main .details')
check('agent: listing published on save', /Published/.test(await agentPage.textContent('main')))
await idle()

// ---- Buyer: signs up, saves requirements, sees the existing listing recommended
const buyerPage = await newPage()
await register(buyerPage, { role: 'buyer', name: 'Rahul Sharma', email: 'rahul@example.com' })
const buyerNav = await visitAllNav(buyerPage, 'buyer')
check('buyer: no agent sections in the nav', !buyerNav.some((h) => ['#/leads', '#/automations', '#/integrations', '#/rent'].includes(h)), buyerNav.join(' '))
await go(buyerPage, `#/leads`)
await buyerPage.waitForTimeout(300)
check('buyer: agent pages are not reachable from the browser', /not part of your account’s role|Page not found/.test(await buyerPage.textContent('main')))
const direct = await buyerPage.evaluate(async () => (await fetch('/api/leads')).status)
check('buyer: the leads API refuses a direct call', direct === 403, String(direct))
await go(buyerPage, `#/requirements`)
await buyerPage.waitForSelector('#rq-form')
await buyerPage.fill('[name=preferred_location]', 'Baner, Pune')
await buyerPage.selectOption('[name=property_type]', 'apartment')
await buyerPage.fill('[name=bedrooms]', '2')
await buyerPage.fill('[name=budget_max]', '5000000')
await buyerPage.check('[name=matchingConsent]')
await buyerPage.click('#rq-save')
await buyerPage.waitForURL(/recommendations/)
await idle()
await buyerPage.click('#rec-refresh')
await buyerPage.waitForTimeout(400)
const recText = await buyerPage.textContent('#recs')
check('buyer: the existing listing is recommended with reasons', /2 BHK in Baner/.test(recText) && /within their budget/.test(recText), recText.slice(0, 200))
await shot(buyerPage, '50-buyer-recommendations')
await go(buyerPage, `#/dashboard`)
await buyerPage.waitForTimeout(400)
check('buyer: home names the assigned agent', /Your agent is Asha Broker/.test(await buyerPage.textContent('main')))
check('buyer: unread badge shows the match notice', (await buyerPage.textContent('#unread')) === '1')

// ---- Seller: signs up, lists a draft, publishes; the buyer hears about it
const sellerPage = await newPage()
await register(sellerPage, { role: 'seller', name: 'Sunita Rao', email: 'sunita@example.com' })
const sellerNav = await visitAllNav(sellerPage, 'seller')
check('seller: seller sections only', sellerNav.includes('#/my-listings') && !sellerNav.includes('#/leads'), sellerNav.join(' '))
await go(sellerPage, `#/my-listings/new`)
await sellerPage.waitForSelector('#p-form')
check('seller: new listings default to draft', !(await sellerPage.isChecked('[name=publish]')))
await sellerPage.fill('[name=title]', '2 BHK near Baner hills')
await sellerPage.selectOption('[name=listing_type]', 'sale')
await sellerPage.selectOption('[name=property_type]', 'apartment')
await sellerPage.fill('[name=price]', '4900000')
await sellerPage.fill('[name=bedrooms]', '2')
await sellerPage.fill('[name=city]', 'Pune')
await sellerPage.fill('[name=locality]', 'Baner')
await sellerPage.click('#p-save')
await sellerPage.waitForURL(/my-listings\/\d+$/)
await idle()
check('seller: draft did not match anyone', t.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'match' AND title LIKE '%hills%'").get().n === 0)
await sellerPage.click('[data-state=publish]')
await sellerPage.waitForTimeout(500)
await idle()
await sellerPage.reload()
await sellerPage.waitForTimeout(500)
const sellerView = await sellerPage.textContent('main')
check('seller: sees how many buyers match, not who', /1 saved buyer requirement/.test(sellerView) && !/Rahul/.test(sellerView), sellerView.slice(0, 200))
await shot(sellerPage, '51-seller-listing')
await go(buyerPage, `#/notifications`)
await buyerPage.waitForTimeout(400)
check('buyer: notified about the newly published listing', /New match: 2 BHK near Baner hills/.test(await buyerPage.textContent('main')))

// ---- Agent: the buyer is in their leads, with the matches; notifications arrived once
await go(agentPage, `#/leads`)
await agentPage.waitForTimeout(500)
check('agent: the self-registered buyer is in their leads', /Rahul Sharma/.test(await agentPage.textContent('main')))
await go(agentPage, `#/notifications`)
await agentPage.waitForTimeout(400)
const agentNotes = await agentPage.textContent('main')
check('agent: told about the new lead and the seller’s listing', /New lead: Rahul Sharma/.test(agentNotes) && /New listing published: 2 BHK near Baner hills/.test(agentNotes))
await go(agentPage, `#/activity`)
await agentPage.waitForTimeout(400)
check('agent: activity log lists processed events', /Lead created/.test(await agentPage.textContent('main')) && /Listing published/.test(await agentPage.textContent('main')))
await shot(agentPage, '52-agent-activity')

// ---- Viewing: agent turns on the scheduler; buyer requests; agent confirms; completed; buyer feedback
const cal = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor('google-calendar'), authId: vs.connectApp(t.db.prepare("SELECT id FROM users WHERE role = 'agent'").get().id, 'google-calendar') }, as: { cookie: (await agentPage.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ') } }))
check('agent: calendar connected (stand-in)', cal.status === 201, String(cal.status))
const agentCookie = { cookie: (await agentPage.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ') }
await t.call('/api/automations/viewing_scheduler', { method: 'PUT', body: { enabled: true, config: { calendarConnectionId: cal.body.connection.id, calendarId: 'primary', confirmation: 'none' } }, as: agentCookie })
const pid = t.db.prepare("SELECT id FROM properties WHERE title = '2 BHK in Baner'").get().id
await go(buyerPage, `#/browse/${pid}`)
await buyerPage.waitForSelector('#p-view')
check('buyer: no street address on the listing page', !/12 Baner Road/.test(await buyerPage.textContent('main')))
await buyerPage.click('#p-view')
await buyerPage.fill('#vr-date', addDays(todayIn('Asia/Kolkata'), 2))
await buyerPage.click('#vr-find')
await buyerPage.waitForSelector('#vr-slots [data-slot]')
await buyerPage.locator('#vr-slots [data-slot]').first().click()
await buyerPage.waitForURL(/my-viewings/)
await buyerPage.waitForTimeout(300)
check('buyer: request waits for the agent', /Waiting for your agent/.test(await buyerPage.textContent('main')))
await idle()
await go(agentPage, `#/viewings`)
await agentPage.waitForSelector('[data-act=confirm]')
await agentPage.click('[data-act=confirm]')
await agentPage.waitForTimeout(800)
await idle()
check('agent: confirming books it in the calendar (stand-in event)', t.db.prepare("SELECT status, event_id FROM viewings").get().status === 'booked')
t.db.prepare("UPDATE viewings SET start_at = '2020-01-01T04:30:00.000Z', end_at = '2020-01-01T05:30:00.000Z'").run()
await go(agentPage, `#/viewings`)
await agentPage.waitForSelector('[data-act=completed]')
await agentPage.click('[data-act=completed]')
await agentPage.waitForTimeout(600)
await idle()
await go(buyerPage, `#/my-viewings`)
await buyerPage.waitForSelector('[data-fb]')
await buyerPage.click('[data-fb]')
await buyerPage.check('input[value=too_expensive]')
await buyerPage.click('.v-extra form button')
await buyerPage.waitForTimeout(600)
await idle()
check('buyer: feedback lowers the budget', /4[,.]?7/.test(String(t.db.prepare('SELECT budget_max FROM leads WHERE buyer_user_id IS NOT NULL').get().budget_max)))
await go(buyerPage, `#/recommendations`)
await buyerPage.waitForTimeout(500)
check('buyer: the rejected listing is no longer recommended', !/2 BHK in Baner<\/a>/.test(await buyerPage.innerHTML('#recs')))

// ---- Rent: the agent links the buyer as tenant and the seller as landlord
await t.call('/api/rent/tenancies', { method: 'POST', body: { tenancy: { tenant_name: 'Rahul Sharma', tenant_email: 'rahul@example.com', landlord_email: 'sunita@example.com', property_label: 'Flat 4B', rent_amount: 28000, due_day: 5, lease_start: todayIn('Asia/Kolkata') } }, as: agentCookie })
await idle()
await go(buyerPage, `#/my-tenancies`)
await buyerPage.waitForTimeout(400)
check('tenant: sees the tenancy, cannot record payments', /Flat 4B/.test(await buyerPage.textContent('main')) && !(await buyerPage.$('[data-pay]')))
await go(sellerPage, `#/my-tenancies`)
await sellerPage.waitForSelector('[data-pay]')
await sellerPage.locator('[data-pay]').first().click()
await sellerPage.fill('.due-extra [name=amount]', '28000')
await sellerPage.fill('.due-extra [name=note]', 'UPI ref 8812')
await sellerPage.click('.due-extra button')
await sellerPage.waitForTimeout(600)
check('landlord: records a payment received', /Paid/.test(await sellerPage.textContent('main')))

// ---- Keyboard and accessibility basics on the sign-in page
const anon = await newPage()
await anon.goto(`${B}/`)
await anon.waitForSelector('#auth-form')
await anon.keyboard.press('Tab')
const focused = await anon.evaluate(() => document.activeElement?.tagName)
check('a11y: keyboard focus reaches a control', ['A', 'INPUT', 'BUTTON'].includes(focused), focused)
check('a11y: every input has a label', await anon.$$eval('#auth-form input:not([type=radio])', (els) => els.every((e) => e.labels?.length)))
await anon.fill('#a-email', 'nobody@example.com')
await anon.fill('#a-password', 'wrong-password-1')
await anon.click('#auth-form button[type=submit]')
await anon.waitForTimeout(400)
check('sign-in: wrong password gives a readable error', /do not match/.test(await anon.textContent('#auth-error')))

// ---- Phone width: no horizontal scroll on the main pages of each role
for (const [who, page, hrefs] of [['buyer', buyerPage, ['#/dashboard', '#/recommendations', '#/my-viewings']], ['seller', sellerPage, ['#/dashboard', '#/my-listings']], ['agent', agentPage, ['#/dashboard', '#/leads', '#/viewings', '#/activity']]]) {
  await page.setViewportSize({ width: 390, height: 800 })
  for (const h of hrefs) {
    await go(page, h)
    await page.waitForTimeout(400)
    const wide = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest('.table-wrap')).slice(0, 3).map((e) => `${e.tagName}.${e.className}`).join(', '))
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/m-${who}-${h.replace(/\W/g, '')}.png` })
    check(`mobile ${who} ${h}: no horizontal scroll`, !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)), wide)
  }
}
await shot(buyerPage, '53-buyer-mobile')

// ---- Sign out ends the session
await sellerPage.click('#account button')
await sellerPage.waitForSelector('#auth-form')
check('sign-out: back to sign-in, API refuses the old session', (await sellerPage.evaluate(async () => (await fetch('/api/me')).status)) === 401)

await browser.close()
await t.close()
const passed = results.filter((r) => r.ok).length
console.log(results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : ` — ${r.detail}`}`).join('\n'))
const extra = problems.filter((p) => !results.some((r) => !r.ok && p.startsWith(r.name)))
if (extra.length) console.log(`\nOther problems:\n${extra.join('\n')}`)
console.log(`\n${passed}/${results.length} checks passed, ${extra.length} other problem(s)`)
process.exit(passed === results.length && !extra.length ? 0 : 1)

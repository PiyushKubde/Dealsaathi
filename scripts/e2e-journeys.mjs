// Browser journeys for the three roles, against the real app with a stand-in for viaSocket (no external sends).
//   node scripts/e2e-journeys.mjs [screenshot-dir]
// Needs Playwright (PLAYWRIGHT_MODULE=/path/to/node_modules, default: the global install). Exits 1 on any failure,
// console error, failed request, or horizontal scroll on a phone-width screen.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { startApp, fakeAi, fakeVs } from '../test/helpers.js'
import { addDays, todayIn } from '../server/time.js'

const require = createRequire(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/')
const { chromium } = require('playwright')
const SHOTS = process.argv[2] || null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const results = []
const problems = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); if (!ok) problems.push(`${name}${detail ? `: ${detail}` : ''}`) }

const vs = fakeVs()
const mail = { id: null } // system email goes through the agent's (stand-in) Gmail once connected below
const ai = fakeAi() // the assistant's decisions are scripted below; nothing reaches a real AI
const t = await startApp({ vs, ai, withUser: false, mailConnection: () => mail.id })
const sentMail = () => vs.calls.filter((c) => c.name === 'runAction' && c.args[2]?.messageBody).map((c) => c.args[2]).at(-1)
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

// ---- Buyer's AI assistant (scripted decisions, real tools): search, explain, free times, confirm a request
const NULLS = { property_id: null, property_ids: null, date: null, start: null, location: null, bedrooms: null, budget_max_amount: null, budget_max_unit: null, budget_min_amount: null, budget_min_unit: null, listing_type: null, property_type: null, limit: null }
const decide = (type, extra = {}) => ({ type, tool: null, message: null, listing_ids: null, ...extra, args: { ...NULLS, ...(extra.args || {}) } })
const hills = t.db.prepare("SELECT id FROM properties WHERE title = '2 BHK near Baner hills'").get().id
const aDay = addDays(todayIn('Asia/Kolkata'), 3)
ai.queue.push(decide('tool', { tool: 'search_listings', args: { location: 'Baner', bedrooms: 2, budget_max_amount: 50, budget_max_unit: 'lakh' } }), decide('answer', { message: 'One listing fits. Shall I check free times?', listing_ids: [hills] }))
await go(buyerPage, '#/assistant')
await buyerPage.waitForSelector('#ag-input')
await buyerPage.fill('#ag-input', 'Find me a 2 BHK in Baner under 50 lakh')
await buyerPage.click('#ag-send')
await buyerPage.waitForSelector('.agent-msg .agent-steps')
const agentText = await buyerPage.textContent('#ag-log')
check('buyer assistant: shows the search it ran and the matching listing with reasons', /Searched published listings/.test(agentText) && /2 BHK near Baner hills/.test(agentText) && /One listing fits/.test(agentText), agentText.slice(0, 300))
check('buyer assistant: no street address in the conversation', !/Baner Road/.test(agentText))
ai.queue.push(decide('tool', { tool: 'get_viewing_slots', args: { property_id: hills, date: aDay } }), decide('ask', { message: 'Which time suits you?' }))
await buyerPage.fill('#ag-input', `Yes, on ${aDay}`)
await buyerPage.click('#ag-send')
await buyerPage.waitForSelector('.agent-msg [data-slot]')
const offered = JSON.parse(t.db.prepare('SELECT state FROM agent_conversations').get().state).offers[0].slots[0]
ai.queue.push(decide('tool', { tool: 'propose_viewing_request', args: { property_ids: [hills], start: offered.start } }))
const viewingsBefore = t.db.prepare('SELECT COUNT(*) AS n FROM viewings').get().n
await buyerPage.locator('.agent-msg [data-slot]').first().click()
await buyerPage.waitForSelector('[data-action] [data-confirm]')
check('buyer assistant: a prepared request is not sent before Confirm', t.db.prepare('SELECT COUNT(*) AS n FROM viewings').get().n === viewingsBefore)
await shot(buyerPage, '55-buyer-assistant')
await buyerPage.click('[data-action] [data-confirm]')
await buyerPage.waitForSelector('.agent-action .notice.ok')
await buyerPage.waitForTimeout(300)
const sentText = await buyerPage.textContent('#ag-log')
check('buyer assistant: Confirm sends one request, described as waiting for the agent', t.db.prepare('SELECT COUNT(*) AS n FROM viewings').get().n === viewingsBefore + 1 && /not booked yet/.test(sentText), sentText.slice(-200))
check('buyer assistant: no calendar event before the agent confirms', t.db.prepare("SELECT status FROM viewings ORDER BY created_at DESC LIMIT 1").get().status === 'draft')
await go(buyerPage, '#/assistant')
await buyerPage.waitForSelector('.agent-msg')
check('buyer assistant: the conversation is there after a reload', /Which time suits you/.test(await buyerPage.textContent('#ag-log')))

// ---- System email through the agent's Gmail (stand-in): verification for the buyer
const agentId = t.db.prepare("SELECT id FROM users WHERE role = 'agent'").get().id
mail.id = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: await vs.serviceIdFor('gmail'), authId: vs.connectApp(agentId, 'gmail') }, as: agentCookie })).body.connection.id
await go(buyerPage, '#/dashboard')
check('buyer: unverified email is shown', /Email not verified/.test(await buyerPage.textContent('#account')))
await buyerPage.click('#verify-send')
await buyerPage.waitForTimeout(500)
const verifyLink = /#\/verify-email\/[A-Za-z0-9_-]+/.exec(sentMail()?.messageBody || '')?.[0]
check('buyer: verification email sent to their own address', Boolean(verifyLink) && sentMail().to === 'rahul@example.com')
await go(buyerPage, verifyLink)
await buyerPage.waitForSelector('text=Email confirmed')
await go(buyerPage, '#/dashboard')
check('buyer: account shows the email as verified', !/Email not verified/.test(await buyerPage.textContent('#account')))

// ---- Rent: nobody is linked by email alone; the agent invites the landlord, who accepts in the browser
await t.call('/api/rent/tenancies', { method: 'POST', body: { tenancy: { tenant_name: 'Rahul Sharma', tenant_email: 'rahul@example.com', landlord_email: 'sunita@example.com', property_label: 'Flat 4B', rent_amount: 28000, due_day: 5, lease_start: todayIn('Asia/Kolkata') } }, as: agentCookie })
await idle()
await go(sellerPage, '#/my-tenancies')
check('landlord: not linked before accepting an invitation', /No tenancy is linked/.test(await sellerPage.textContent('main')))
await go(buyerPage, '#/my-tenancies')
check('tenant: linked because their email is verified', /Flat 4B/.test(await buyerPage.textContent('main')) && !(await buyerPage.$('[data-pay]')))
const tid = t.db.prepare('SELECT id FROM tenancies').get().id
await go(agentPage, `#/rent/${tid}`)
await agentPage.locator('[data-party=landlord] [data-invite]').click()
await agentPage.waitForSelector('[data-party=landlord] .invite-out input')
const inviteLink = await agentPage.inputValue('[data-party=landlord] .invite-out input')
check('agent: invitation link shown once', /#\/invite\/[A-Za-z0-9_-]{40,}/.test(inviteLink))
await go(buyerPage, inviteLink.slice(inviteLink.indexOf('#')))
await buyerPage.waitForSelector('main h1')
check('wrong account: invitation cannot be accepted and reveals no property', !(await buyerPage.$('#inv-accept')) && !/Flat 4B/.test(await buyerPage.textContent('main')))
await go(sellerPage, inviteLink.slice(inviteLink.indexOf('#')))
await sellerPage.waitForSelector('#inv-accept')
await sellerPage.click('#inv-accept')
await sellerPage.waitForURL(/my-tenancies/)
await sellerPage.waitForSelector('[data-pay]')
await sellerPage.locator('[data-pay]').first().click()
await sellerPage.fill('.due-extra [name=amount]', '28000')
await sellerPage.fill('.due-extra [name=note]', 'UPI ref 8812')
await sellerPage.click('.due-extra button')
await sellerPage.waitForTimeout(600)
check('landlord: records a payment received', /Paid/.test(await sellerPage.textContent('main')))

// ---- Password reset from the sign-in page
const resetPage = await newPage()
await resetPage.goto(`${B}/`)
await resetPage.waitForSelector('#auth-forgot')
await resetPage.click('#auth-forgot')
await resetPage.fill('#fg-email', 'asha@agency.in')
await resetPage.click('#fg-form button[type=submit]')
await resetPage.waitForSelector('#fg-msg .notice')
check('reset: neutral confirmation shown', /If an account uses that email/.test(await resetPage.textContent('#fg-msg')))
const resetLink = /#\/reset-password\/[A-Za-z0-9_-]+/.exec(sentMail()?.messageBody || '')?.[0]
await go(resetPage, resetLink)
await resetPage.fill('#rp-pw', 'a-new-password-22')
await resetPage.click('#rp-form button[type=submit]')
await resetPage.waitForSelector('#auth-form')
check('reset: the agent’s old browser session is signed out', (await agentPage.evaluate(async () => (await fetch('/api/me')).status)) === 401)
await resetPage.fill('#a-email', 'asha@agency.in')
await resetPage.fill('#a-password', 'a-new-password-22')
await resetPage.click('#auth-form button[type=submit]')
await resetPage.waitForSelector('#nav a')
check('reset: signs in with the new password', /Asha Broker/.test(await resetPage.textContent('#account')))
await agentPage.close()
const agentPage2 = resetPage

// ---- Hostile text: every role's pages show it as text, never run it
const XSS = '<img src=x onerror="window.__xss=1">'
const asAgent = { cookie: (await agentPage2.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ') }
await t.call('/api/properties', { method: 'POST', body: { property: { title: `Flat ${XSS}`, listing_type: 'sale', property_type: 'apartment', bedrooms: 2, price: 4600000, city: 'Pune', locality: 'Baner', notes: XSS, amenities: [XSS] } }, as: asAgent })
await t.call('/api/leads', { method: 'POST', body: { lead: { full_name: `Evil ${XSS}`, customer_type: 'buyer', phone: '9000000099', notes: XSS, preferred_location: 'Baner, Pune', bedrooms: 2, budget_max: 5000000 } }, as: asAgent })
await idle()
const xssPages = [[agentPage2, ['#/properties', '#/leads', '#/notifications', '#/activity', '#/dashboard']], [buyerPage, ['#/browse', '#/recommendations', '#/notifications']], [sellerPage, ['#/dashboard', '#/notifications']]]
for (const [page, hrefs] of xssPages) {
  for (const h of hrefs) {
    await go(page, h)
    await page.waitForTimeout(300)
    const ran = await page.evaluate(() => window.__xss === 1)
    const shown = (await page.textContent('main')).includes('<img src=x')
    check(`xss: ${h} shows hostile text inert`, !ran, shown ? 'shown as text' : 'not on this page')
  }
}
const leadId = t.db.prepare("SELECT id FROM leads WHERE full_name LIKE 'Evil%'").get().id
await go(agentPage2, `#/leads/${leadId}`)
await agentPage2.waitForTimeout(400)
check('xss: lead detail page', !(await agentPage2.evaluate(() => window.__xss === 1)) && (await agentPage2.textContent('main')).includes('<img src=x'))
const xssPid = t.db.prepare("SELECT id FROM properties WHERE title LIKE 'Flat <img%'").get().id
await go(agentPage2, `#/properties/${xssPid}`)
await agentPage2.waitForTimeout(400)
check('xss: listing detail page', !(await agentPage2.evaluate(() => window.__xss === 1)) && (await agentPage2.textContent('main')).includes('<img src=x'))

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
for (const [who, page, hrefs] of [['buyer', buyerPage, ['#/dashboard', '#/assistant', '#/recommendations', '#/my-viewings']], ['seller', sellerPage, ['#/dashboard', '#/my-listings']], ['agent', agentPage2, ['#/dashboard', '#/leads', '#/viewings', '#/activity']]]) {
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
await sellerPage.click('#sign-out')
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

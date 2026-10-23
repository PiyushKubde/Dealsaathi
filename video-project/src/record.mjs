// Records real screen footage of DealSaathi for the demo video.
//   node src/record.mjs <clip>|all [--force]
// STAGING ONLY for anything signed in: synthetic "Demo ·" data and @example.com accounts. The production clip is the
// signed-out landing page (no user data). No Assistant typing, so no AI calls; staging has system email off.
// Frames come from Chromium's screencast at native 1920×1080 and are encoded at 30 fps.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire('/opt/node22/lib/node_modules/')
const { chromium } = require('playwright')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STAGING = 'https://dealsaathi-staging.embarko.app'
const PRODUCTION = 'https://dealsaathi-app.embarko.app'
const STATE_FILE = process.env.DEMO_STATE // the staging demo state (password), mode 600, outside the repo
const RUN_FILE = process.env.VIDEO_RUN // which data steps already happened, outside the repo
if (!STATE_FILE || !RUN_FILE) { console.error('set DEMO_STATE and VIDEO_RUN'); process.exit(2) }
const password = JSON.parse(readFileSync(STATE_FILE, 'utf8')).password
const run = existsSync(RUN_FILE) ? JSON.parse(readFileSync(RUN_FILE, 'utf8')) : { done: {} }
const saveRun = () => writeFileSync(RUN_FILE, JSON.stringify(run, null, 1), { mode: 0o600 })
const TITLE = run.title ||= 'Demo · 4 BHK villa in Scheme 54'
const EMAIL = { agent: 'demo-agent@example.com', seller: 'demo-seller@example.com', buyer: 'demo-buyer@example.com' }

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function login(who) {
  const r = await fetch(`${STAGING}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: STAGING }, body: JSON.stringify({ email: EMAIL[who], password }) })
  if (!r.ok) throw new Error(`${who} login failed: ${r.status}`)
  const c = (r.headers.getSetCookie?.() || []).map((x) => x.split(';')[0]).find((x) => x.startsWith('ds_session='))
  return { name: 'ds_session', value: c.slice('ds_session='.length), domain: new URL(STAGING).hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }
}

// A visible cursor and click ripple, since the screencast does not draw the system pointer.
// The page is laid out as a 1440×810 window and drawn at 4/3 zoom, so the screencast is native 1920×1080.
// Viewport-height rules are divided by the zoom so the sidebar still fits the window (recording browser only).
const Z = 4 / 3
const CURSOR = `(() => {
  const Z = ${Z}
  const zoom = () => {
    if (document.getElementById('__zoom')) return
    document.documentElement.style.zoom = String(Z)
    const z = document.createElement('style'); z.id = '__zoom'
    z.textContent = '.shell{min-height:calc(100vh / ' + Z + ')}.sidebar{height:calc(100vh / ' + Z + ')}dialog{max-height:calc(85vh / ' + Z + ')}'
    document.documentElement.appendChild(z)
  }
  if (document.documentElement) zoom(); document.addEventListener('DOMContentLoaded', zoom)
  const add = () => {
    if (document.getElementById('__cur')) return
    const s = document.createElement('style')
    s.textContent = '#__cur{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}' +
      '.__rip{zoom:' + (1 / Z) + ';position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid rgba(16,185,129,.9);background:rgba(16,185,129,.18);z-index:2147483646;pointer-events:none;animation:__r .55s ease-out forwards}' +
      '@keyframes __r{from{transform:scale(.4);opacity:1}to{transform:scale(1.6);opacity:0}}'
    document.documentElement.appendChild(s)
    const c = document.createElement('div'); c.id = '__cur'; c.style.zoom = String(1 / Z)
    c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l15 11.2-6.6.9 3.9 7.6-3 1.5-3.9-7.7L4 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    document.documentElement.appendChild(c)
    const pos = window.__curPos || [-100, -100]
    c.style.transform = 'translate(' + pos[0] + 'px,' + pos[1] + 'px)'
  }
  document.addEventListener('mousemove', (e) => { window.__curPos = [e.clientX, e.clientY]; add(); document.getElementById('__cur').style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)' }, true)
  document.addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.className = '__rip'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700) }, true)
  if (document.readyState !== 'loading') add(); else document.addEventListener('DOMContentLoaded', add)
})()`

async function withClip(name, { who, url }, body) {
  const browser = await chromium.launch({ proxy: { server: process.env.HTTPS_PROXY } })
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' })
  if (who) await context.addCookies([await login(who)])
  await context.addInitScript(CURSOR)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  let mouse = [960, 610]
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
  const moveTo = async (x, y, ms = 650) => {
    const [x0, y0] = mouse; const n = Math.max(8, Math.round(ms / 16))
    for (let i = 1; i <= n; i++) { const t = ease(i / n); await page.mouse.move(x0 + (x - x0) * t, y0 + (y - y0) * t); await wait(16) }
    mouse = [x, y]
  }
  const target = async (loc) => { await loc.scrollIntoViewIfNeeded(); await wait(250); const b = await loc.boundingBox(); return [b.x + Math.min(b.width / 2, 60), b.y + b.height / 2] }
  const hover = async (loc, ms) => { const [x, y] = await target(loc); await moveTo(x, y, ms) }
  const click = async (loc, ms) => { await hover(loc, ms); await wait(180); await page.mouse.down(); await wait(90); await page.mouse.up(); await wait(350) }
  const type = async (loc, text) => { await click(loc); await page.keyboard.type(text, { delay: 55 }) }
  const settle = async () => { await page.waitForFunction(() => !document.querySelector('main .loading'), null, { timeout: 15000 }).catch(() => {}); await wait(400) }
  const scroll = async (dy, ms = 1200) => { const n = Math.round(ms / 16); for (let i = 0; i < n; i++) { await page.mouse.wheel(0, dy / n); await wait(16) } }
  const nav = async (hash) => { await click(page.locator(`#nav a[data-nav="${hash}"]`)); await settle() }

  await page.goto(url); await settle()
  await page.mouse.move(...mouse)
  const dir = join(ROOT, 'recordings', 'raw', name)
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  const cdp = await context.newCDPSession(page)
  const frames = []
  cdp.on('Page.screencastFrame', async (f) => {
    const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`)
    writeFileSync(file, Buffer.from(f.data, 'base64')); frames.push({ file, t: f.metadata.timestamp })
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })
  await page.mouse.move(mouse[0] + 1, mouse[1]); await wait(800)
  await body({ page, moveTo, hover, click, type, settle, scroll, nav, wait })
  await wait(900)
  await page.mouse.move(mouse[0] + 1, mouse[1]); await wait(100)
  await cdp.send('Page.stopScreencast')
  await browser.close()
  if (errors.length) console.warn(`${name}: page errors: ${errors.join('; ')}`)
  // Variable-rate frames → constant 30 fps clip, each frame held until the next one arrived.
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? Math.max(f.t + 0.5, frames.at(-1).t + 0.5)) - f.t).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`
  writeFileSync(join(dir, 'list.txt'), 'ffconcat version 1.0\n' + list)
  const out = join(ROOT, 'recordings', `${name}.mp4`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', 'scale=1920:1080:flags=lanczos,fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', out])
  const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString().trim()
  console.log(`✓ ${name}: ${frames.length} frames, ${Number(dur).toFixed(1)} s → recordings/${name}.mp4`)
}

const li = (page, sel) => page.locator(sel).filter({ hasText: TITLE }).first()

const CLIPS = {
  // Agent home: the redesigned dashboard with the demo agent's synthetic data.
  'agent-dashboard': () => withClip('agent-dashboard', { who: 'agent', url: `${STAGING}/#/dashboard` }, async ({ page, hover, scroll, wait }) => {
    await wait(900)
    for (const m of await page.locator('main .metric').all()) await hover(m, 420)
    await wait(500); await scroll(520, 1600); await wait(1200); await hover(page.locator('main h2').nth(1), 600); await wait(900); await scroll(-520, 1400); await wait(600)
  }),
  // Integrations page: the apps a broker connects through ViaSocket (read-only, nothing is connected or changed).
  'agent-integrations': () => withClip('agent-integrations', { who: 'agent', url: `${STAGING}/#/dashboard` }, async ({ page, nav, hover, scroll, wait }) => {
    await nav('integrations'); await wait(1000)
    for (const name of ['Gmail', 'Google Calendar', 'Slack']) { const c = page.locator('main .card, main li').filter({ hasText: name }).first(); if (await c.count()) await hover(c, 600); await wait(500) }
    await scroll(400, 1400); await wait(1000)
  }),
  // Seller lists a new property (synthetic). Matching runs in the background; no AI.
  'seller-listing': () => withClip('seller-listing', { who: 'seller', url: `${STAGING}/#/my-listings` }, async ({ page, click, type, settle, wait }) => {
    await click(page.locator('main a[href="#/my-listings/new"]').first()); await settle()
    await type(page.locator('#f-title'), TITLE)
    await page.selectOption('#f-listing_type', 'sale'); await page.selectOption('#f-property_type', 'villa')
    await type(page.locator('#f-price'), '9200000'); await type(page.locator('#f-bedrooms'), '4')
    await type(page.locator('#f-city'), 'Indore'); await type(page.locator('#f-locality'), 'Scheme 54')
    await type(page.locator('#f-area_sqft'), '2400'); await type(page.locator('#f-amenities'), 'Garden, Covered parking, Power backup')
    await click(page.locator('input[name=publish]'))
    await click(page.locator('#p-save')); await settle(); await wait(2200)
  }),
  // Buyer: finds the listing, says "I'm interested", then makes an offer from My requests.
  'buyer-offer': () => withClip('buyer-offer', { who: 'buyer', url: `${STAGING}/#/browse` }, async ({ page, click, hover, type, nav, settle, wait }) => {
    await wait(600)
    const card = page.locator('main tr').filter({ hasText: TITLE }).first()
    await click(card); await settle(); await wait(700)
    await click(page.locator('[data-interest-btn]')); await wait(2200)
    await nav('my-requests'); await wait(700)
    const row = li(page, 'li[data-i]')
    await click(row.locator('[data-make-offer]')); await wait(500)
    await type(row.locator('input[name=amount]'), '8800000')
    await type(row.locator('textarea[name=terms]'), 'Demo: can close in 60 days')
    await click(row.locator('[data-send]')); await settle(); await wait(1600)
    await hover(li(page, 'li[data-i]').locator('.offer-box'), 600); await wait(1200)
  }),
  // Buyer's agent forwards the offer to the owner.
  'agent-forward': () => withClip('agent-forward', { who: 'agent', url: `${STAGING}/#/dashboard` }, async ({ page, nav, click, type, settle, wait }) => {
    await nav('offers'); await wait(800)
    const row = li(page, '#of-mine li[data-ao]')
    await click(row.locator('[data-ao-forward]')); await wait(400)
    await type(row.locator('input[name=note]'), 'Verified demo buyer, ready to proceed')
    await click(row.locator('.i-msg button')); await settle(); await wait(2000)
  }),
  // Owner (seller) counters; the buyer's identity stays private.
  'seller-counter': () => withClip('seller-counter', { who: 'seller', url: `${STAGING}/#/dashboard` }, async ({ page, nav, click, type, hover, settle, wait }) => {
    await nav('listing-offers'); await wait(800)
    const row = li(page, 'li[data-oo]')
    await hover(row, 700); await wait(600)
    await click(row.locator('[data-oo-counter]')); await wait(400)
    await type(row.locator('input[name=amount]'), '9000000')
    await type(row.locator('input[name=note]'), 'Can include the modular kitchen')
    await click(row.locator('.i-msg button')); await settle(); await wait(2000)
  }),
  // Buyer accepts the counter: "accepted in principle", with the disclaimer.
  'buyer-accept': () => withClip('buyer-accept', { who: 'buyer', url: `${STAGING}/#/dashboard` }, async ({ page, nav, click, hover, settle, wait }) => {
    await nav('my-requests'); await wait(800)
    const row = li(page, 'li[data-i]')
    await hover(row.locator('.offer-box'), 700); await wait(900)
    await click(row.locator('[data-o-accept]')); await wait(1100)
    await click(page.locator('#confirm-ok')); await settle(); await wait(1500)
    await hover(li(page, 'li[data-i]').locator('.offer-box .notice'), 700); await wait(1800)
  }),
  // Agent records the outcome, then the notifications every step produced.
  'agent-close': () => withClip('agent-close', { who: 'agent', url: `${STAGING}/#/dashboard` }, async ({ page, nav, click, type, hover, scroll, settle, wait }) => {
    await nav('offers'); await wait(800)
    const row = li(page, '#of-mine li[data-ao]')
    await click(row.locator('[data-ao-won]')); await wait(400)
    await type(row.locator('input[name=note]'), 'Agreement to be signed offline')
    await click(row.locator('.i-msg button')); await settle(); await wait(1500)
    await nav('notifications'); await wait(1200)
    for (const n of (await page.locator('main li').filter({ hasText: TITLE }).all()).slice(0, 4)) await hover(n, 450)
    await wait(1200)
  }),
  // Buyer's matches with their scores and reasons (read-only).
  'buyer-recommendations': () => withClip('buyer-recommendations', { who: 'buyer', url: `${STAGING}/#/dashboard` }, async ({ page, nav, hover, scroll, wait }) => {
    await nav('recommendations'); await wait(1200)
    for (const c of (await page.locator('main .card, main li').all()).slice(0, 3)) await hover(c, 650)
    await scroll(300, 1400); await wait(1200)
  }),
  // Production: the public, signed-out landing page only.
  'prod-landing': () => withClip('prod-landing', { url: PRODUCTION }, async ({ scroll, wait }) => {
    await wait(1800); await scroll(600, 2200); await wait(1500); await scroll(-600, 1600); await wait(800)
  })
}
const DATA_STEPS = ['seller-listing', 'buyer-offer', 'agent-forward', 'seller-counter', 'buyer-accept', 'agent-close']

const [which = 'all'] = process.argv.slice(2)
const force = process.argv.includes('--force')
for (const name of which === 'all' ? Object.keys(CLIPS) : which.split(',')) {
  if (!CLIPS[name]) { console.error(`unknown clip ${name}`); process.exit(2) }
  // Data steps change staging state, so each runs once, in order, unless forced.
  if (DATA_STEPS.includes(name)) {
    if (run.done[name] && !force) { console.log(`- ${name}: already recorded (use --force to redo the clip; staging data has moved on)`); continue }
    const prev = DATA_STEPS[DATA_STEPS.indexOf(name) - 1]
    if (prev && !run.done[prev]) { console.error(`${name} needs ${prev} first`); process.exit(2) }
  }
  await CLIPS[name]()
  if (DATA_STEPS.includes(name)) { run.done[name] = new Date().toISOString(); saveRun() }
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startApp, fakeVs, signedInUser, vsError } from './helpers.js'

test('the embed token is signed for the signed-in user only, and is never cached', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const res = await t.call('/api/integrations/token')
    assert.equal(res.status, 200)
    assert.equal(res.body.embedToken, `signed-token-for-${t.user.id}`)
    assert.match(res.headers.get('cache-control'), /no-store/)
    assert.deepEqual(vs.calls.find((c) => c.name === 'token').args, [t.user.id])
    assert.equal((await t.call('/api/integrations/token', { as: null })).status, 401, 'no session, no token')
    const other = signedInUser(t.db, { name: 'Other Broker' })
    assert.equal((await t.call('/api/integrations/token', { as: other })).body.embedToken, `signed-token-for-${other.id}`)
  } finally { await t.close() }
})

test('the browser never receives the signing secret, and the official browser SDK is served', async () => {
  const t = await startApp({ vs: fakeVs() })
  try {
    const sdk = await fetch(`${t.base}/vendor/viasocket-apps-browser.js`)
    assert.equal(sdk.status, 200)
    assert.match(sdk.headers.get('content-type'), /javascript/)
    assert.match(await sdk.text(), /export async function connect\(/)
    for (const file of ['public/app.js', 'public/index.html']) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      assert.doesNotMatch(src, /VIASOCKET_EMBED_SECRET|signEmbedToken|runAction|script_id/i, file)
    }
  } finally { await t.close() }
})

test('app search and app details come from the catalog, with input checked', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    assert.deepEqual((await t.call('/api/integrations/apps?q=g')).body.apps, [], 'one letter searches nothing')
    const found = await t.call('/api/integrations/apps?q=gmail')
    assert.equal(found.body.apps[0].name, 'Gmail')
    const details = await t.call('/api/integrations/apps/rowo0bqrhj5g')
    assert.equal(details.body.requiresAuth, true)
    assert.equal(details.body.actions[0].name, 'Send Email')
    assert.equal(details.body.actions[0].action_version_id, undefined, 'version ids are not sent to the browser')
    assert.equal((await t.call('/api/integrations/apps/not-an-id!')).status, 400)
    assert.equal((await t.call('/api/integrations/apps/rowunknown1')).status, 404)
  } finally { await t.close() }
})

test('a connection is saved only if viaSocket has it for this user; auth_id never goes back to the browser', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const forged = await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowo0bqrhj5g', authId: 'authForged_rowo0bqrhj5g' } })
    assert.equal(forged.status, 403)
    assert.equal(forged.body.error.code, 'connection_not_yours')

    const authId = vs.connectGmail(t.user.id)
    const wrongApp = await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowbu58rc', authId } })
    assert.equal(wrongApp.status, 400)

    const saved = await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowo0bqrhj5g', authId } })
    assert.equal(saved.status, 201)
    assert.equal(saved.body.connection.status, 'active')
    assert.equal(saved.body.connection.label, 'me@example.com')
    assert.doesNotMatch(saved.text, new RegExp(authId))

    const again = await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowo0bqrhj5g', authId } })
    assert.equal(again.body.connection.id, saved.body.connection.id, 'saving twice keeps one row')

    const list = await t.call('/api/integrations/connections')
    assert.equal(list.body.live, true)
    assert.equal(list.body.connections.length, 1)
    assert.doesNotMatch(list.text, new RegExp(authId))
  } finally { await t.close() }
})

test('one user cannot save, see, reconnect or disconnect another user’s connection', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const other = signedInUser(t.db, { name: 'Other Broker' })
    const theirs = vs.connectGmail(other.id)
    const steal = await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowo0bqrhj5g', authId: theirs } })
    assert.equal(steal.status, 403, 'their auth_id is not in my viaSocket connections')

    const saved = await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowo0bqrhj5g', authId: theirs }, as: other })
    const id = saved.body.connection.id
    assert.equal((await t.call('/api/integrations/connections')).body.connections.length, 0)
    assert.equal((await t.call(`/api/integrations/connections/${id}/reconnect`, { method: 'POST', body: {} })).status, 404)
    assert.equal((await t.call(`/api/integrations/connections/${id}`, { method: 'DELETE' })).status, 404)
    assert.ok(!vs.calls.some((c) => c.name === 'revokeConnection'))
  } finally { await t.close() }
})

test('live status: expired and missing connections are reported as such', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const authId = vs.connectGmail(t.user.id)
    await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowo0bqrhj5g', authId } })
    vs.state.connections[t.user.id][0].isExpired = true
    assert.equal((await t.call('/api/integrations/connections')).body.connections[0].status, 'expired')
    vs.state.connections[t.user.id] = []
    assert.equal((await t.call('/api/integrations/connections')).body.connections[0].status, 'missing')
    vs.fail.listConnections = vsError('boom', 500)
    const down = await t.call('/api/integrations/connections')
    assert.equal(down.body.live, false)
    assert.equal(down.body.connections[0].status, 'unknown')
  } finally { await t.close() }
})

test('reconnect hands the owner what connect() needs to renew in place', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const authId = vs.connectGmail(t.user.id)
    const { id } = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowo0bqrhj5g', authId } })).body.connection
    const res = await t.call(`/api/integrations/connections/${id}/reconnect`, { method: 'POST', body: {} })
    assert.deepEqual(res.body, { embedToken: `signed-token-for-${t.user.id}`, serviceId: 'rowo0bqrhj5g', authId })
  } finally { await t.close() }
})

test('disconnect pauses the enabled app, revokes on viaSocket, then forgets; a failure keeps the record', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    const authId = vs.connectGmail(t.user.id)
    const { id } = (await t.call('/api/integrations/connections', { method: 'POST', body: { serviceId: 'rowo0bqrhj5g', authId } })).body.connection
    t.db.prepare("INSERT INTO enabled_apps (user_id, auth_id, service_id, script_id, created_at) VALUES (?, ?, 'rowo0bqrhj5g', 'scriEnabled1', 'now')").run(t.user.id, authId)

    vs.fail.revokeConnection = vsError('upstream down', 500)
    const failed = await t.call(`/api/integrations/connections/${id}`, { method: 'DELETE' })
    assert.equal(failed.status, 502)
    assert.equal((await t.call('/api/integrations/connections')).body.connections.length, 1, 'still listed: it was not revoked')

    const ok = await t.call(`/api/integrations/connections/${id}`, { method: 'DELETE' })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.revokedOnViasocket, true)
    const order = vs.calls.filter((c) => ['setFlowStatus', 'revokeConnection'].includes(c.name)).slice(-2).map((c) => c.name)
    assert.deepEqual(order, ['setFlowStatus', 'revokeConnection'], 'flows paused before the connection is revoked')
    assert.equal(vs.calls.filter((c) => c.name === 'setFlowStatus').at(-1).args[2], 2)
    assert.equal((await t.call('/api/integrations/connections')).body.connections.length, 0)
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM enabled_apps').get().n, 0)
  } finally { await t.close() }
})

test('without viaSocket configured, integrations say so and leads still work', async () => {
  const t = await startApp()
  try {
    const res = await t.call('/api/integrations/token')
    assert.equal(res.status, 503)
    assert.equal(res.body.error.code, 'viasocket_not_configured')
    assert.equal((await t.call('/api/leads')).status, 200)
    assert.equal((await t.call('/api/health')).body.viasocket, 'not_configured')
  } finally { await t.close() }
})

test('viaSocket errors reach the user without credentials in them', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    vs.fail.search = vsError('failed calling https://flow.sokt.io/func/scriAbC123xyz with token eyJhbGciOiJIUzI1NiJ9.payload.sig', 500)
    const res = await t.call('/api/integrations/apps?q=gmail')
    assert.equal(res.status, 502)
    assert.doesNotMatch(res.text, /sokt\.io|scriAbC123xyz|eyJhbGci/)
    vs.fail.search = vsError('fetch failed', null)
    assert.equal((await t.call('/api/integrations/apps?q=gmail')).body.error.code, 'viasocket_unreachable')
  } finally { await t.close() }
})

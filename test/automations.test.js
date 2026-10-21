import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, fakeVs, signedInUser } from './helpers.js'
import { flowRef } from '../server/automations/service.js'

function withFlows(vs, userId) {
  vs.state.flows[userId] = [
    { id: 'scriUserFlow1', title: 'New lead → Slack', status: 'active', description: 'Posts new leads', serviceId: '', authId: '', webhook: 'https://flow.sokt.io/func/scriUserFlow1' },
    { id: 'scriOldFlow22', title: 'Old', status: 'deleted', description: '', serviceId: '', authId: '', webhook: '' }
  ]
}

test('flows are listed from viaSocket without their script ids or run URLs', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    withFlows(vs, t.user.id)
    const res = await t.call('/api/automations/flows')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.flows.map((f) => f.title), ['New lead → Slack'], 'deleted flows are hidden')
    assert.equal(res.body.flows[0].ref, flowRef(t.user.id, 'scriUserFlow1'))
    assert.doesNotMatch(res.text, /scriUserFlow1|sokt\.io/)
  } finally { await t.close() }
})

test('pause and resume go through the server to setFlowStatus, for the owner only', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    withFlows(vs, t.user.id)
    const ref = flowRef(t.user.id, 'scriUserFlow1')
    const paused = await t.call(`/api/automations/flows/${ref}/status`, { method: 'POST', body: { status: 'paused' } })
    assert.equal(paused.status, 200)
    assert.deepEqual(vs.calls.find((c) => c.name === 'setFlowStatus').args, [t.user.id, 'scriUserFlow1', 2])
    await t.call(`/api/automations/flows/${ref}/status`, { method: 'POST', body: { status: 'active' } })
    assert.equal(vs.calls.filter((c) => c.name === 'setFlowStatus').at(-1).args[2], 1)
    assert.equal((await t.call(`/api/automations/flows/${ref}/status`, { method: 'POST', body: { status: 'deleted' } })).status, 400)

    const other = signedInUser(t.db, { name: 'Other' })
    assert.equal((await t.call(`/api/automations/flows/${ref}/status`, { method: 'POST', body: { status: 'paused' }, as: other })).status, 404)
  } finally { await t.close() }
})

test('a flow event from the prebuilt UI is recorded only for a flow viaSocket lists for this user', async () => {
  const vs = fakeVs()
  const t = await startApp({ vs })
  try {
    withFlows(vs, t.user.id)
    const ok = await t.call('/api/automations/flow-events', { method: 'POST', body: { flowId: 'scriUserFlow1', action: 'published', title: 'Spoofed title' } })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.title, 'New lead → Slack', 'title read from viaSocket, not the browser')
    assert.equal((await t.call('/api/automations/flows')).body.events[0].event, 'published')

    assert.equal((await t.call('/api/automations/flow-events', { method: 'POST', body: { flowId: 'scriNotMine99', action: 'published' } })).status, 404)
    assert.equal((await t.call('/api/automations/flow-events', { method: 'POST', body: { flowId: 'x', action: 'published' } })).status, 400)
    assert.equal((await t.call('/api/automations/flow-events', { method: 'POST', body: { flowId: 'scriUserFlow1', action: 'hacked' } })).status, 400)
    const other = signedInUser(t.db, { name: 'Other' })
    assert.equal((await t.call('/api/automations/flow-events', { method: 'POST', body: { flowId: 'scriUserFlow1', action: 'published' }, as: other })).status, 404)
  } finally { await t.close() }
})

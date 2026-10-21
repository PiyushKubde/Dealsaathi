// The skill's test-connection step (https://flow.viasocket.com/documentation/skill/test-connection.md) for
// Gmail · Send Email, run against the shared test user "apps-api-test-user" of this project.
//
//   node --env-file=.env scripts/live-gmail-check.js                 # read-only: finds the connection, lists From options
//   node --env-file=.env scripts/live-gmail-check.js --send --to you@example.com   # sends ONE real test email
//
// The test connection's ids are never printed or committed; only DealSaathi's own users' connections are used by the app.
import { createViasocketGateway, viasocketConfigured } from '../server/viasocket.js'
import { GMAIL, buildSendEmailInput, readGmailResult } from '../server/followups/service.js'

const TEST_USER = 'apps-api-test-user'
const args = process.argv.slice(2)
const send = args.includes('--send')
const to = args[args.indexOf('--to') + 1]

if (!viasocketConfigured) throw new Error('Add the viaSocket values to .env first.')
const vs = createViasocketGateway()
const serviceId = await vs.serviceIdFor(GMAIL.slug)
const connections = await vs.listConnections(TEST_USER)
// The test screen connects within this project; access_level_id names the project a connection was made in.
const mine = connections.filter((c) => c.service_id === serviceId && c.access_level_id === process.env.VIASOCKET_PROJECT_ID && !c.isExpired)
console.log(`Gmail service ${serviceId}; ${mine.length} active test connection(s) in this project.`)
if (!mine.length) {
  console.log('Connect one on viaSocket’s Apps API test screen first: see "Live checks" in README.md.')
  process.exit(2)
}
const authId = mine[0].id
const versionId = await vs.versionIdFor(serviceId, GMAIL.actionId, GMAIL.version)
const { options } = await vs.listOptions(TEST_USER, versionId, { fieldKey: 'from', authId, existingFields: {} })
console.log('From options (real listOptions result):', JSON.stringify(options))
if (!send) process.exit(0)
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw new Error('Pass --to <a test inbox you own>.')

const flows = await vs.listFlows(TEST_USER)
const existing = flows.find((f) => f.serviceId === serviceId && f.authId === authId && f.status !== 'deleted')
if (existing?.status === 'paused') await vs.setFlowStatus(TEST_USER, existing.id, 1)
const scriptId = existing?.id ?? (await vs.enable(TEST_USER, serviceId, authId)).scriptId
const inputData = buildSendEmailInput({
  recipient: to,
  subject: 'DealSaathi live test: Gmail · Send Email via viaSocket',
  body: 'This is a one-off test email sent by DealSaathi through viaSocket’s Gmail Send Email action.\n\nNo reply needed.',
  fromName: 'DealSaathi test'
})
const result = await vs.runAction(scriptId, versionId, inputData)
console.log('Real runAction result:', JSON.stringify(result))
console.log('DealSaathi reads it as:', JSON.stringify(readGmailResult(result)))

import { api, badge, busy, confirmDialog, dateTime, errorText, field, h, mount, statusBadge, toast } from '../lib.js'

export function notConfiguredBanner(what) {
  return h('div', { class: 'banner warn' }, h('div', {},
    h('strong', {}, 'viaSocket is not connected on the server'),
    `${what} The server has no VIASOCKET_EMBED_SECRET, so AI and app actions are switched off. See Integrations for setup.`))
}

export function sampleBanner(text) {
  return h('div', { class: 'banner sample' }, h('div', {}, h('strong', {}, 'Includes sample data'), text))
}

const MESSAGE_STATUS_TEXT = {
  draft: 'Draft — not sent.',
  sending: 'Sending…',
  sent: 'Sent: Gmail accepted it and returned a message id. Delivery to the inbox is not tracked.',
  unconfirmed: 'Gmail answered without a message id, so DealSaathi cannot confirm it was sent. Check your Sent folder before retrying.',
  failed: 'Sending failed. The draft is kept; you can edit it and try again.'
}

/**
 * An editable follow-up or reminder draft with an explicit, confirmed Send. Sending is offered only when
 * Gmail is really connected; otherwise the card says so and keeps the draft.
 */
export function draftCard(initial, { gmailReady, onSent } = {}) {
  let message = initial
  const card = h('div', { class: 'card stack' })

  function render() {
    const editable = ['draft', 'failed'].includes(message.status)
    const subject = h('input', { name: 'subject', value: message.subject, disabled: !editable, maxlength: 200 })
    const body = h('textarea', { name: 'body', rows: 8, disabled: !editable }, message.body)
    const save = h('button', { class: 'small', onclick: () => busy(save, persist()) }, 'Save edits')
    const send = h('button', { class: 'primary small', disabled: !gmailReady || !message.recipient, onclick: () => sendIt(send) }, 'Send via Gmail…')

    async function persist() {
      try {
        message = (await api(`/messages/${message.id}`, { method: 'PATCH', body: { subject: subject.value, body: body.value } })).message
        toast('Draft saved.')
        render()
      } catch (e) {
        toast(errorText(e), 'error')
      }
    }

    async function sendIt(button) {
      if (subject.value !== message.subject || body.value !== message.body) await persist()
      const ok = await confirmDialog({
        title: 'Send this email?',
        body: h('div', { class: 'stack tight' },
          h('p', {}, `To: ${message.recipient}`),
          h('p', {}, `Subject: ${message.subject}`),
          h('p', { class: 'muted small' }, 'It is sent from your connected Gmail account.')),
        confirmLabel: 'Send now'
      })
      if (!ok) return
      await busy(button, (async () => {
        try {
          message = (await api(`/messages/${message.id}/send`, { method: 'POST' })).message
          toast(message.status === 'sent' ? 'Gmail accepted the email.' : 'Gmail did not confirm the send.', message.status === 'sent' ? 'info' : 'error')
          onSent?.(message)
        } catch (e) {
          toast(errorText(e), 'error')
          message = (await api(`/messages?${message.lead_id ? `lead_id=${message.lead_id}` : `rent_id=${message.rent_id}`}`)).messages.find((m) => m.id === message.id) || message
        }
        render()
      })())
    }

    mount(card,
      h('div', { class: 'row between' },
        h('div', { class: 'row' }, h('h3', {}, message.kind === 'rent_reminder' ? 'Rent reminder' : 'Follow-up email'), statusBadge(message.status),
          message.generated_by === 'ai' ? badge('AI draft', 'info') : message.generated_by === 'template' ? badge('From record', '') : null),
        h('span', { class: 'small muted' }, dateTime(message.sent_at || message.created_at))),
      h('p', { class: 'small' }, message.recipient ? `To: ${message.recipient}` : h('span', { class: 'field-error' }, 'No email address on record: add one before sending.')),
      field('Subject', subject),
      field('Message', body),
      h('p', { class: 'small muted' }, MESSAGE_STATUS_TEXT[message.status]),
      message.error ? h('p', { class: 'field-error' }, message.error) : null,
      message.provider_message_id ? h('p', { class: 'small muted' }, 'Gmail message id: ', h('span', { class: 'mono' }, message.provider_message_id)) : null,
      editable
        ? h('div', { class: 'row' }, save, send,
            gmailReady ? null : h('span', { class: 'small muted' }, 'Sending is not configured: connect Gmail in Integrations.'))
        : null
    )
  }

  render()
  return card
}

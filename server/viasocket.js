import jwt from 'jsonwebtoken'

/**
 * Ids copied from the live viaSocket app documents (viasocket/apps/viasocket-*.md, fetched with
 * format=http for org 53645 / project projwZ9V7Wb3). Version ids run actions and list options;
 * action ids are for the Connect popup's filteredActions.
 */
export const APPS = {
  gmail: {
    key: 'gmail',
    name: 'Gmail',
    serviceId: 'rowo0bqrhj5g',
    icon: 'https://stuff.thingsofbrand.com/gmail.com/images/imge_idrA5FDGTH_1763454052978.svg',
    purpose: 'Send lead follow-ups and rent reminders from your own Gmail account.',
    actionIds: ['rowogelpy0h6'], // Send Email
    sendEmail: { actionVersionId: 'rowwj0sfmhub' }
  },
  googleCalendar: {
    key: 'googleCalendar',
    name: 'Google Calendar',
    serviceId: 'rowkhibv5efp',
    icon: 'https://stuff.thingsofbrand.com/google.com/images/img7_Google-Calendar.png',
    purpose: 'Check your availability and book property viewings on your calendar.',
    actionIds: ['rowuitv4m6uy', 'row7kcom7ds1'], // Create Calendar Event, Get Free/Busy Information
    createEvent: { actionVersionId: 'rown3bkuc5jc' },
    freeBusy: { actionVersionId: 'row0ce18xwwk' }
  }
}

export const APP_BY_SERVICE = Object.fromEntries(Object.values(APPS).map((app) => [app.serviceId, app]))

/** Time zones Google Calendar's Create Calendar Event accepts (its `timeZone` field's fixed values). */
export const CALENDAR_TIME_ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London',
  'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney',
  'Asia/Dubai', 'Europe/Moscow', 'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo',
  'Africa/Johannesburg', 'Asia/Singapore', 'Europe/Madrid', 'Asia/Hong_Kong'
]

export class ViaSocketError extends Error {
  constructor(message, { code = 'service_error', status = 502, detail } = {}) {
    super(message)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

export function createViaSocket(config, { fetchImpl = globalThis.fetch } = {}) {
  const v = config.viasocket
  const configured = Boolean(v.orgId && v.projectId && v.secret)

  function assertConfigured() {
    if (!configured) {
      throw new ViaSocketError('viaSocket is not configured on the server (VIASOCKET_EMBED_SECRET is missing).', {
        code: 'not_configured',
        status: 503
      })
    }
  }

  /** The three-claim HS256 embed token. unique_identifier is DealSaathi's stable user id, never the email. */
  function embedToken(userId) {
    assertConfigured()
    return jwt.sign(
      { org_id: v.orgId, project_id: v.projectId, unique_identifier: `dealsaathi-user-${userId}` },
      v.secret,
      { algorithm: 'HS256' }
    )
  }

  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000)
      })
    } catch (error) {
      throw new ViaSocketError(`Could not reach viaSocket (${error.name === 'TimeoutError' ? 'timed out' : 'network error'}).`, {
        code: 'unreachable'
      })
    }
    let payload = null
    const text = await response.text()
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = { raw: text.slice(0, 500) }
    }
    if (response.status === 401 || response.status === 498) {
      throw new ViaSocketError('viaSocket rejected the embed token. Check VIASOCKET_EMBED_SECRET and the org/project ids.', {
        code: 'unauthorized',
        status: 502
      })
    }
    if (response.status === 429) {
      throw new ViaSocketError('viaSocket is rate limiting requests. Wait a moment and try again.', { code: 'rate_limited', status: 429 })
    }
    if (!response.ok || payload?.success === false) {
      throw new ViaSocketError(payload?.message || `viaSocket answered HTTP ${response.status}.`, {
        code: 'service_error',
        status: 502
      })
    }
    return payload
  }

  async function call(path, userId, { method = 'POST', body } = {}) {
    const payload = await request(`${v.apiUrl}${path}`, { method, headers: { authorization: embedToken(userId) }, body })
    return payload?.data
  }

  return {
    configured,
    embedToken,

    listConnections: (userId) => call('/embed/authentications', userId, { method: 'GET' }),

    async listUserFlows(userId) {
      const data = await call(`/projects/${v.projectId}/integrations`, userId, { method: 'GET' })
      return data?.flows || []
    },

    async findEnabledApp(userId, serviceId) {
      const flows = await this.listUserFlows(userId)
      return flows.find((flow) => flow.service_id === serviceId && flow.status === 'active')?.id || null
    },

    async enableApp(userId, serviceId, authId) {
      const data = await call(`/embed/enable/${serviceId}/${encodeURIComponent(authId)}`, userId)
      if (!data?.script_id) throw new ViaSocketError('viaSocket did not return a script id when enabling the app.')
      return data.script_id
    },

    async listOptions(userId, actionVersionId, fieldKey, existingFields, authId) {
      const data = await call(`/embed/list-options/${actionVersionId}`, userId, {
        body: { fieldKey, auth_id: authId, existingFields: existingFields || {} }
      })
      if (data && !Array.isArray(data) && data.response && Number(data.response.status) >= 400) {
        throw new ViaSocketError(data.response.data?.message || 'The connected account could not be read. Reconnect it.', {
          code: 'connection_unreadable'
        })
      }
      return Array.isArray(data) ? data : data?.data || []
    },

    /** Runs an app action on the user's script_id (the credential; it never leaves the server). */
    async runAction(scriptId, actionVersionId, inputData) {
      const payload = await request(`${v.runUrl}/func/${scriptId}`, {
        method: 'POST',
        body: { action_version_id: actionVersionId, inputData }
      }).catch((error) => {
        if (error instanceof ViaSocketError && error.code === 'service_error') {
          throw new ViaSocketError(`The app rejected the action: ${error.message}`, { code: 'action_failed' })
        }
        throw error
      })
      const isEnvelope = payload && typeof payload === 'object' && typeof payload.success === 'boolean' && 'data' in payload
      return isEnvelope ? payload.data : payload
    },

    /** AI in the product: POST /embed/ai/message. Backend only; the prompt never reaches a browser. */
    async aiMessage(userId, { message, threadId, prompt, jsonSchema }) {
      const body = { message, thread_id: threadId, prompt }
      if (v.aiService && v.aiModel) {
        body.service = v.aiService
        body.model = v.aiModel
      }
      if (jsonSchema) {
        body.response_type = 'json_schema'
        body.json_schema = jsonSchema
      }
      const data = await call('/embed/ai/message', userId, { body })
      if (data?.finish_reason === 'truncated') {
        throw new ViaSocketError('The AI answer was cut off before it finished. Try a shorter request.', { code: 'ai_truncated' })
      }
      let content = data?.content
      if (jsonSchema && typeof content === 'string') {
        try {
          content = JSON.parse(content)
        } catch {
          throw new ViaSocketError('The AI returned an answer that is not valid JSON.', { code: 'ai_invalid_output' })
        }
      }
      return { content, threadId: data?.thread_id, messageId: data?.message_id }
    }
  }
}

// The buyer's feedback page. It knows only its own token, and shows only what the server returns for it.
(function () {
  const root = document.getElementById('root')
  const token = location.pathname.split('/').filter(Boolean)[1] || ''
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const api = async (method, body) => {
    const res = await fetch(`/api/public/feedback/${encodeURIComponent(token)}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, referrerPolicy: 'no-referrer'
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error?.message || 'Something went wrong. Please try again.')
    return data
  }
  const done = (text) => { root.innerHTML = `<h1>Thank you</h1><div class="msg ok">${esc(text)}</div>` }

  api('GET').then((d) => {
    if (d.state === 'submitted') return done('Your feedback was already received.')
    if (d.state === 'expired') { root.innerHTML = '<h1>This link has expired</h1><p class="muted">Please reply to your broker’s email instead.</p>'; return }
    root.innerHTML = `
      <h1>Hi ${esc(d.firstName)}, how was your viewing?</h1>
      <p class="muted">Viewing on ${esc(d.viewedOn)}. Choose one answer for each property you saw.</p>
      <form id="f">
        ${d.properties.map((p) => `<section class="card"><h2>${esc(p.title)}</h2><div class="muted">${esc(p.area)}</div>
          <div class="opts" role="radiogroup" aria-label="${esc(p.title)}">${Object.entries(d.verdicts).map(([k, label]) => `
            <label class="opt"><input type="radio" name="p${p.id}" value="${esc(k)}"> ${esc(label)}</label>`).join('')}</div></section>`).join('')}
        <section class="card"><label for="c"><strong>Anything else?</strong> <span class="muted">(optional)</span></label>
          <textarea id="c" maxlength="1000" placeholder="What would your ideal property look like?"></textarea></section>
        <div id="m"></div>
        <button type="submit">Send feedback</button>
      </form>`
    const form = document.getElementById('f')
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const responses = d.properties.map((p) => ({ propertyId: p.id, verdict: form.querySelector(`input[name="p${p.id}"]:checked`)?.value })).filter((r) => r.verdict)
      const m = document.getElementById('m')
      if (!responses.length) { m.innerHTML = '<div class="msg err">Choose an answer for at least one property.</div>'; return }
      const btn = form.querySelector('button')
      btn.disabled = true
      try {
        await api('POST', { responses, comments: document.getElementById('c').value })
        done('Your feedback has been sent to your broker. It will help them find better matches for you.')
      } catch (error) {
        m.innerHTML = `<div class="msg err">${esc(error.message)}</div>`
        btn.disabled = false
      }
    })
  }).catch((error) => { root.innerHTML = `<h1>Feedback</h1><div class="msg err">${esc(error.message)}</div>` })
})()

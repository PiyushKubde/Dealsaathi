// The launch film's motion graphics, drawn in the browser one frame at a time.
// render.mjs calls setup(data) once, then frame(t) for every frame and screenshots the page.
// Everything is a pure function of t, so any frame can be rendered alone and in any order.
/* global document, window */
(() => {
  const W = 1920, H = 1080
  let D, L, root, shots, captionsEl, tagEl
  const pending = []

  // ---------- helpers ----------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
  const lerp = (a, b, x) => a + (b - a) * x
  const outCubic = (x) => 1 - (1 - clamp(x)) ** 3
  const inOut = (x) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2 }
  const outBack = (x) => { x = clamp(x); const c = 1.6; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2 }
  const prog = (t, a, d = 0.45) => clamp((t - a) / d)
  const el = (tag, cls, html, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; (parent || root).appendChild(e); return e }
  const css = (e, o) => { for (const k in o) e.style[k] = o[k] }
  const ICON = (p, s = 40, c = 'currentColor') => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`
  const LOGO = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#34d399"/><path d="M8 15.5 16 9l8 6.5V24H8z" fill="#fff"/></svg>`
  /** When `word` (spoken form, n-th occurrence) is said in line `id`. */
  const at = (id, word, n = 0) => {
    const hits = L[id].spoken.filter((w) => w.w === word)
    if (!hits[n]) throw new Error(`no "${word}" in ${id}`)
    return hits[n].s
  }
  /** Pop-in style for an element appearing at time a. */
  const pop = (e, t, a, { y = 40, s = 0.7, d = 0.42 } = {}) => {
    const p = prog(t, a, d), b = outBack(p)
    css(e, { opacity: String(clamp(p * 2.2)), transform: `translateY(${(1 - b) * y}px) scale(${lerp(s, 1, b)})` })
  }
  const frameSrc = (name, sec) => {
    const n = Math.max(1, Math.min(D.clipFrames[name], Math.round(sec * 30) + 1))
    return `${D.clipBase}/${name}/f${String(n).padStart(5, '0')}.jpg`
  }
  const setImg = (img, src) => {
    if (img.dataset.src === src) return
    img.dataset.src = src
    img.src = src
    pending.push(img.decode().catch(() => {}))
  }

  // ---------- device: a browser window showing a clip, with a focus zoom ----------
  function device(parent, { w, url, ratio = 9 / 16 }) {
    const dev = el('div', 'dev', `<div class="bar"><i></i><i></i><i></i><span>${url}</span></div><div class="scr"><div class="zoomer"><img></div></div>`, parent)
    const h = Math.round(w * ratio)
    css(dev, { width: `${w}px` })
    css(dev.querySelector('.scr'), { height: `${h}px` })
    const zoomer = dev.querySelector('.zoomer'), img = dev.querySelector('img')
    return {
      el: dev,
      show(name, sec) { setImg(img, frameSrc(name, sec)) },
      focus(fx, fy, z) {
        const tx = clamp(w / 2 - fx * w * z, w - w * z, 0), ty = clamp(h / 2 - fy * h * z, h - h * z, 0)
        css(zoomer, { transform: `translate(${tx}px, ${ty}px) scale(${z})` })
      }
    }
  }
  /** Source time for a clip played from a to b over the shot's [u0, u1]. */
  const span = (u, u0, u1, a, b) => lerp(a, b, clamp((u - u0) / (u1 - u0)))

  // ---------- background ----------
  let bg
  function drawBg(t) {
    const b = bg.children
    css(b[0], { transform: `translate(${Math.sin(t * 0.21) * 160}px, ${Math.cos(t * 0.17) * 90}px)` })
    css(b[1], { transform: `translate(${Math.cos(t * 0.13) * 200}px, ${Math.sin(t * 0.19) * 120}px)` })
    css(b[2], { transform: `translate(${Math.sin(t * 0.11 + 2) * 180}px, ${Math.cos(t * 0.23) * 140}px)` })
  }

  // ---------- captions: the current phrase, the spoken word lit up ----------
  function phrases(line) {
    const out = []
    let cur = []
    line.words.forEach((w, i) => {
      cur.push(w)
      const end = /[.,:;?!]$/.test(w.w) || cur.length >= 7
      if (end && (cur.length >= 3 || i === line.words.length - 1)) { out.push(cur); cur = [] }
    })
    if (cur.length) out.push(cur)
    return out
  }
  function drawCaptions(t) {
    const line = D.plan.lines.find((l) => t >= l.start - 0.15 && t <= l.end + 0.35)
    if (!line) { captionsEl.style.opacity = '0'; return }
    const ph = phrases(line)
    const cur = ph.find((p, i) => t < (ph[i + 1] ? ph[i + 1][0].s - 0.05 : Infinity)) || ph[ph.length - 1]
    captionsEl.style.opacity = String(clamp((t - line.start + 0.15) / 0.12) * clamp((line.end + 0.35 - t) / 0.15))
    captionsEl.innerHTML = cur.map((w) => {
      const state = t >= w.e ? 'said' : t >= w.s - 0.03 ? 'now' : 'next'
      return `<span class="cw ${state}">${w.w.replace(/</g, '&lt;')}</span>`
    }).join(' ')
  }

  // ---------- shots ----------
  const S = {}

  S.hook1 = {
    build(s) {
      s.bubbles = ['Is the flat still available?', 'Can we visit on Sunday?', 'Any update on my offer?', 'Please call me back', 'Sent you the documents', 'Who else is interested?', 'Is the price negotiable?', 'Did the owner reply?']
        .map((txt, i) => el('div', 'bubble', `<b>${['Buyer', 'Seller', 'Buyer', 'Owner', 'Tenant', 'Seller', 'Buyer', 'Agent'][i]}</b>${txt}`, s.root))
      s.kick = el('div', 'kicker-c hookkick', 'Buying · Selling · Renting', s.root)
      s.words = ['Calls.', 'Messages.', 'Follow-ups.'].map((w, i) => el('div', 'giant', w, s.root))
      s.words.forEach((w, i) => css(w, { left: '150px', top: `${250 + i * 190}px`, color: ['#ffffff', '#cfe9dc', '#6ee7b7'][i] }))
      s.times = [at('hook1', 'calls'), at('hook1', 'messages'), at('hook1', 'follow')]
    },
    draw(s, t, u, d, out) {
      s.bubbles.forEach((b, i) => {
        const x = 980 + (i % 2) * 420 + Math.sin(i * 1.7) * 60, y = 1150 - ((t * 120 + i * 170) % 1400)
        css(b, { transform: `translate(${x}px, ${y}px) rotate(${Math.sin(i + t * 0.6) * 3}deg)`, opacity: String(0.85 * clamp(u / 0.6) * clamp((820 - y) / 160) * clamp((y + 60) / 120)) })
      })
      pop(s.kick, t, L.hook1.start - 0.1, { y: 20, s: 0.95 })
      css(s.kick, { left: '154px', top: '120px' })
      s.words.forEach((w, i) => pop(w, t, s.times[i] - 0.05, { y: 80, s: 0.6 }))
      css(s.root, { opacity: String(1 - out), transform: `scale(${1 + out * 0.08})`, filter: `blur(${out * 10}px)` })
    }
  }

  S.hook2 = {
    build(s) {
      const items = [['Agents', 'juggle chat groups and spreadsheets', 'leads', 'agents'], ['Buyers', 'wait for updates', 'browse', 'buyers'], ['Sellers', 'rarely know who’s interested', 'offers', 'sellers']]
      s.cards = items.map(([a, b, ic, w], i) => {
        const c = el('div', 'glass', `<div class="gi">${ICON(D.icons[ic], 54, '#6ee7b7')}</div><div class="gt">${a}</div><div class="gs">${b}</div><div class="badge">${[12, 4, '?'][i]}</div>`, s.root)
        css(c, { left: `${150 + i * 560}px`, top: '300px' })
        c.at = at('hook2', w)
        return c
      })
    },
    draw(s, t, u, d, out) {
      s.cards.forEach((c, i) => {
        const p = prog(t, c.at - 0.1, 0.5), b = outBack(p)
        const jitter = p >= 1 ? Math.sin(t * 9 + i) * 1.4 : 0
        css(c, { opacity: String(clamp(p * 2)), transform: `translateY(${(1 - b) * 120}px) rotate(${(1 - b) * (i - 1) * 8 + jitter}deg)` })
      })
      css(s.root, { opacity: String(1 - out), transform: `translateY(${-out * 80}px)` })
    }
  }

  S.reveal = {
    build(s) {
      s.flash = el('div', 'flash', '', s.root)
      s.rings = [0, 1, 2].map(() => el('div', 'ring', '', s.root))
      s.logo = el('div', 'rlogo', LOGO(180), s.root)
      s.name = el('div', 'rname', [...'DealSaathi'].map((c) => `<span>${c}</span>`).join(''), s.root)
      s.sub = el('div', 'rsub', 'The AI-powered real estate workspace', s.root)
      s.chips = ['Agents', 'Buyers', 'Sellers'].map((c) => el('div', 'chip', c, s.root))
      s.tHit = at('reveal', 'launching')
      s.tName = at('reveal', 'deal')
      s.tSub = at('reveal', 'a')
      s.tChips = [at('reveal', 'agents'), at('reveal', 'buyers'), at('reveal', 'sellers')]
      s.kick = el('div', 'rkick', 'Introducing', s.root)
    },
    draw(s, t, u, d, out) {
      const h = s.tHit
      css(s.flash, { opacity: String(t < h ? 0 : clamp(1 - (t - h) / 0.5) * 0.85) })
      s.rings.forEach((r, i) => { const p = clamp((t - h - i * 0.12) / 1.4); css(r, { opacity: String(p > 0 ? (1 - p) * 0.7 : 0), transform: `translate(-50%,-50%) scale(${0.3 + p * 3.2})` }) })
      const lp = prog(t, h - 0.05, 0.6)
      css(s.logo, { opacity: String(clamp(lp * 2)), transform: `translate(-50%,-50%) scale(${outBack(lp) * 1}) rotate(${(1 - outBack(lp)) * -25}deg)`, top: `${lerp(520, 330, inOut((t - s.tName + 0.1) / 0.6))}px` })
      pop(s.kick, t, h - 0.25, { y: 20, s: 0.9 })
      ;[...s.name.children].forEach((c, i) => { const p = prog(t, s.tName - 0.05 + i * 0.035, 0.45); css(c, { opacity: String(p), transform: `translateY(${(1 - outCubic(p)) * 60}px)`, display: 'inline-block' }) })
      pop(s.sub, t, s.tSub - 0.1, { y: 24, s: 0.96 })
      s.chips.forEach((c, i) => { pop(c, t, s.tChips[i] - 0.05, { y: 30, s: 0.5 }); css(c, { left: `${700 + i * 190}px` }) })
      css(s.root, { opacity: String(1 - out), transform: `scale(${1 - out * 0.12})` })
    }
  }

  /** A product shot: text block on one side, a device on the other. */
  function productShot(cfg) {
    return {
      build(s) {
        s.text = el('div', 'ptext', `<div class="pk">${cfg.kicker}</div><div class="ph">${cfg.head}</div>${(cfg.subs || []).map((x) => `<div class="ps">${x[0]}</div>`).join('')}`, s.root)
        css(s.text, cfg.side === 'right' ? { left: '1240px', width: '600px' } : { left: '110px', width: '560px' })
        s.persp = el('div', 'persp', '', s.root)
        s.dev = device(s.persp, { w: cfg.w || 1120, url: cfg.url, ratio: cfg.ratio || 9 / 16 })
        css(s.persp, cfg.side === 'right' ? { left: '80px', top: `${cfg.top || 190}px` } : { left: `${W - (cfg.w || 1120) - 80}px`, top: `${cfg.top || 190}px` })
        s.subAt = (cfg.subs || []).map((x) => x[1] ? at(cfg.id, ...[].concat(x[1])) : null)
        if (cfg.extra) cfg.extra.build(s)
      },
      draw(s, t, u, d, out) {
        const enter = outCubic(u / 0.7), dir = cfg.side === 'right' ? -1 : 1
        css(s.persp.firstChild, { transform: `perspective(2200px) rotateY(${dir * lerp(-28, -7, enter) + Math.sin(t * 0.5) * 1.2}deg) rotateX(${lerp(10, 3, enter)}deg) translateX(${(1 - enter) * dir * 400}px) translateY(${Math.sin(t * 0.8) * 6}px)`, opacity: String(clamp(u / 0.35)) })
        const kids = s.text.children
        pop(kids[0], t, s.start + 0.1, { y: 20, s: 0.95 })
        pop(kids[1], t, s.start + 0.2, { y: 40, s: 0.9 })
        for (let i = 2; i < kids.length; i++) pop(kids[i], t, s.subAt[i - 2] != null ? s.subAt[i - 2] - 0.1 : s.start + 0.3 + i * 0.15, { y: 24, s: 0.95 })
        cfg.play(s, t, u, d)
        if (cfg.extra) cfg.extra.draw(s, t, u, d)
        css(s.root, { opacity: String(1 - out), transform: `translateX(${-out * dir * 160}px)` })
      }
    }
  }

  S.dash = productShot({ id: 'dash', kicker: 'For agents', head: 'One dashboard.', url: 'dealsaathi-staging.embarko.app · demo data',
    subs: [['Leads', 'leads'], ['Listings', 'listings'], ['Viewings', 'viewings'], ['Follow-ups', 'follow']],
    play(s, t, u, d) { s.dev.show('dash', span(u, 0, d, 0.4, 9)); const z = inOut((u - 1.2) / (d - 1.2)); s.dev.focus(0.55, 0.32, lerp(1, 1.32, z)) } })

  S.ai = productShot({ id: 'ai', side: 'right', kicker: 'AI lead entry', head: 'Just describe it.', url: 'dealsaathi-staging.embarko.app · demo data',
    subs: [['DealSaathi’s AI fills in the details', 'fills']],
    play(s, t, u, d) { s.dev.show('ai', span(u, 0, d * 0.95, 1.2, 15.2)); s.dev.focus(0.3, 0.92, lerp(1.05, 1.85, inOut((u - 0.6) / 1.6))) },
    extra: {
      build(s) { s.spark = el('div', 'spark', ICON(D.icons.assistant, 120, '#6ee7b7'), s.root) },
      draw(s, t, u) { css(s.spark, { left: '1560px', top: '760px', opacity: String(clamp((u - 0.5) / 0.4)), transform: `rotate(${t * 40}deg) scale(${1 + Math.sin(t * 4) * 0.08})` }) }
    } })

  S.seller = productShot({ id: 'seller', kicker: 'For sellers', head: 'List in minutes.', url: 'dealsaathi-staging.embarko.app · demo data',
    subs: [['Auto-matched to every buyer’s saved requirements', 'matched']],
    play(s, t, u, d) { s.dev.show('seller', span(u, 0, d * 0.92, 0, 28.3)); s.dev.focus(0.55, lerp(0.25, 0.75, inOut(u / d)), 1.25) } })

  S.buyer = productShot({ id: 'buyer', side: 'right', kicker: 'For buyers', head: 'See what fits.', url: 'dealsaathi-staging.embarko.app · demo data',
    subs: [['Matches with reasons', 'fits'], ['One tap: “I’m interested”', 'tap'], ['Make an offer', 'offer']],
    play(s, t, u, d) {
      const sw = at('buyer', 'tap') - s.start - 0.2
      if (u < sw) { s.dev.show('recs', span(u, 0, sw, 1.0, 5.0)); s.dev.focus(0.4, 0.4, 1.35) } else { s.dev.show('offer', span(u, sw, d * 0.97, 4.0, 28.5)); s.dev.focus(0.5, 0.5, lerp(1.15, 1.3, (u - sw) / (d - sw))) }
    } })

  S.offer = {
    build(s) {
      s.head = el('div', 'chead', 'Offers, without the back-and-forth', s.root)
      const steps = [['forward', 'Agent forwards it', '₹88 L offer', 'forwards'], ['counter', 'Owner counters', '₹90 L', 'counter'], ['accept', 'Buyer accepts', 'In principle ✓', 'accepts']]
      const lineOf = L.offer ? ['offer', 'offer', 'offer'] : ['w_forward', 'w_forward', 'w_accept']
      s.cols = steps.map(([clip, title, chip, word], i) => {
        const col = el('div', 'ocol', `<div class="otitle"><span class="on">${i + 1}</span>${title}</div><div class="ochip">${chip}</div>`, s.root)
        css(col, { left: `${90 + i * 600}px`, top: '250px' })
        const dv = device(col, { w: 540, url: 'demo data' })
        return { col, dv, clip, at: at(lineOf[i], word) }
      })
      s.arrows = [0, 1].map((i) => { const a = el('div', 'arrow', '', s.root); css(a, { left: `${640 + i * 600}px`, top: '560px' }); return a })
    },
    draw(s, t, u, d, out) {
      pop(s.head, t, s.start + 0.05, { y: 30, s: 0.95 })
      s.cols.forEach((c, i) => {
        pop(c.col, t, c.at - 0.35, { y: 90, s: 0.85, d: 0.5 })
        const n = D.clipFrames[c.clip] / 30
        c.dv.show(c.clip, clamp(n - 3.2 + (t - c.at) * 1.0, 0, n - 0.05))
        c.dv.focus(0.45, 0.4, 1.55)
      })
      s.arrows.forEach((a, i) => css(a, { width: `${50 * outCubic(prog(t, s.cols[i + 1].at - 0.3, 0.4))}px` }))
      css(s.root, { opacity: String(1 - out), transform: `scale(${1 + out * 0.06})` })
    }
  }

  S.notify = productShot({ id: 'notify', kicker: 'Everyone in the loop', head: 'Every step, notified.', url: 'dealsaathi-staging.embarko.app · demo data', w: 1040,
    subs: [['🔒 Buyer identity stays private', 'private']],
    play(s, t, u, d) { s.dev.show('notif', span(u, 0, d, 2.5, 8.8)); s.dev.focus(0.45, 0.3, 1.35) },
    extra: {
      build(s) {
        s.toasts = [['New offer', 'Demo · 4 BHK villa in Scheme 54 · ₹88,00,000', 'every'], ['Counter-offer', 'Demo · 4 BHK villa in Scheme 54 · ₹90,00,000', 'notifies'], ['Offer accepted in principle', 'Demo · 4 BHK villa in Scheme 54', 'people']]
          .map(([a, b, w]) => { const e = el('div', 'toast2', `${ICON(D.icons.notifications, 30, '#065f46')}<div><b>${a}</b><span>${b}</span></div>`, s.root); e.at = at('notify', w); return e })
      },
      draw(s, t) { s.toasts.forEach((e, i) => { const p = outBack(prog(t, e.at - 0.1, 0.45)); css(e, { left: `${lerp(2000, 1180, p)}px`, top: `${640 + i * 112}px`, opacity: String(clamp(p * 2)) }) }) }
    } })

  S.tools = productShot({ id: 'tools', side: 'right', kicker: 'Works with your tools', head: 'Connected.', url: 'dealsaathi-staging.embarko.app · demo data', w: 1060,
    subs: [['Alerts', 'alerts'], ['Reminders', 'reminders'], ['Viewings booked in your calendar', 'viewings']],
    play(s, t, u, d) { s.dev.show('integ', span(u, 0, d, 3.5, 11)); s.dev.focus(0.5, 0.25, 1.3) },
    extra: {
      build(s) {
        s.apps = [['Gmail', '#ea4335', 'gmail'], ['Slack', '#611f69', 'slack'], ['Google Calendar', '#1a73e8', 'google']]
          .map(([n, c, w]) => { const e = el('div', 'apptile', `<i style="background:${c}">${n[0]}</i>${n}`, s.root); e.at = at('tools', w); return e })
      },
      draw(s, t) { s.apps.forEach((e, i) => { pop(e, t, e.at - 0.1, { y: 50, s: 0.5 }); css(e, { left: `${1240 + (i % 2) * 300}px`, top: `${640 + Math.floor(i / 2) * 120}px` }) }) }
    } })

  S.live = {
    build(s) {
      s.persp = el('div', 'persp', '', s.root)
      s.dev = device(s.persp, { w: 1300, url: 'dealsaathi-app.embarko.app' })
      css(s.persp, { left: '310px', top: '520px' })
      s.dot = el('div', 'livedot', '', s.root)
      s.head = el('div', 'livehead', 'Live today.', s.root)
      s.url = el('div', 'urlpill', 'dealsaathi-app.embarko.app', s.root)
      s.chips = [['Buyers', 'buyer'], ['Sellers', 'seller'], ['Agent teams', 'team']].map(([c, w]) => { const e = el('div', 'chip', c, s.root); e.at = at('live', w); return e })
    },
    draw(s, t, u, d, out) {
      const e = outCubic(u / 0.8)
      css(s.persp.firstChild, { transform: `perspective(2000px) rotateX(${lerp(40, 22, e)}deg) translateY(${(1 - e) * 300}px)`, opacity: String(clamp(u / 0.4)) })
      s.dev.show('landing', span(u, 0, d, 0.5, 7.5)); s.dev.focus(0.5, 0.3, 1.05)
      pop(s.head, t, at('live', 'live') - 0.15, { y: 50, s: 0.7 })
      css(s.dot, { opacity: String(clamp((t - at('live', 'live')) / 0.3)), transform: `scale(${1 + 0.25 * Math.sin(t * 6)})` })
      pop(s.url, t, at('live', 'today') - 0.05, { y: 20, s: 0.9 })
      s.chips.forEach((c, i) => { pop(c, t, c.at - 0.05, { y: 30, s: 0.5 }); css(c, { left: `${515 + [0, 190, 390][i]}px`, top: '440px' }) })
      css(s.root, { opacity: String(1 - out) })
    }
  }

  S.buildTitle = {
    build(s) {
      s.k = el('div', 'kicker-c', 'Behind the launch', s.root)
      s.h = el('div', 'btitle', 'How we built it', s.root)
      s.tagrow = el('div', 'tagrow', '', s.root)
      s.tags = ['Claude Code', 'ViaSocket SDK', 'Embarko'].map((x) => el('div', 'chip big', x, s.tagrow))
    },
    draw(s, t, u, d, out) {
      css(s.k, { left: '50%', top: '340px' }); pop(s.k, t, s.start + 0.05, { y: 20, s: 0.95 }); s.k.style.transform += ' translateX(-50%)'
      pop(s.h, t, s.start + 0.15, { y: 50, s: 0.85 })
      s.tags.forEach((g, i) => pop(g, t, s.start + 0.45 + i * 0.18, { y: 40, s: 0.6 }))
      css(s.root, { opacity: String(1 - out), transform: `scale(${1 + out * 0.15})` })
    }
  }

  S.claude = productShot({ id: 'claude', kicker: 'Step 1', head: 'Built with Claude Code', url: 'claude.ai/code', w: 1180, top: 210, ratio: 958 / 1920,
    subs: [['From one detailed prompt', 'detailed'], ['…refined along the way', 'refining']],
    play(s, t, u, d) { s.dev.show('claude', span(u, 0, d, 0.2, 15.5)); s.dev.focus(0.3, 0.3, lerp(1.0, 1.45, inOut((u - 0.8) / (d - 0.8)))) } })

  S.viasocket = {
    build(s) {
      s.text = el('div', 'ptext', '<div class="pk">Step 2</div><div class="ph">ViaSocket SDK</div><div class="ps">Integrations + AI, behind one SDK</div><div class="ps">No connection built from scratch</div>', s.root)
      css(s.text, { left: '110px', width: '600px' })
      s.setup = el('div', 'shot-card', `<img src="${D.clipBase}/vsetup/f00001.jpg">`, s.root)
      s.code = el('div', 'codecard', '<div class="cbar"><i></i><i></i><i></i><span>server/viasocket.js</span></div><pre></pre>', s.root)
      s.lines = D.code
      s.subAt = [at('viasocket', 'integrations'), at('viasocket', 'without')]
    },
    draw(s, t, u, d, out) {
      const k = s.text.children
      pop(k[0], t, s.start + 0.1, { y: 20, s: 0.95 }); pop(k[1], t, s.start + 0.2, { y: 40, s: 0.9 }); pop(k[2], t, s.subAt[0] - 0.1); pop(k[3], t, s.subAt[1] - 0.1)
      const p1 = outBack(prog(t, s.start + 0.15, 0.55))
      css(s.setup, { left: '820px', top: '150px', opacity: String(clamp(p1 * 2)), transform: `perspective(1800px) rotateY(${(1 - p1) * -30}deg) scale(${lerp(0.8, 1, p1)})` })
      const p2 = outBack(prog(t, s.start + 1.2, 0.55))
      css(s.code, { left: '880px', top: '520px', opacity: String(clamp(p2 * 2)), transform: `translateY(${(1 - p2) * 80}px)` })
      const chars = Math.floor(clamp((t - s.start - 1.5) / (d - 2.2)) * s.lines.join('\n').length)
      let left = chars
      s.code.querySelector('pre').innerHTML = s.lines.map((ln) => { const part = ln.slice(0, Math.max(0, left)); left -= ln.length + 1; return part.replace(/</g, '&lt;').replace(/(ViaSocket|runAction)/g, '<em>$1</em>').replace(/('[^']*')/g, '<q>$1</q>') }).join('\n') + '<span class="caret">▍</span>'
      css(s.root, { opacity: String(1 - out), transform: `translateX(${-out * 160}px)` })
    }
  }

  S.embarko = productShot({ id: 'embarko', side: 'right', kicker: 'Step 3', head: 'Hosted on Embarko', url: 'embarko.ai/app', w: 1180, top: 210, ratio: 958 / 1920,
    subs: [['One hosting prompt', 'one'], ['Claude Code deployed it', 'deployed'], ['Traffic and scheduled jobs, one dashboard', 'traffic']],
    play(s, t, u, d) {
      const sw = at('embarko', 'deployed') - s.start + 0.3
      if (u < sw) { s.dev.show('host', span(u, 0, sw, 1.0, 21.0)); s.dev.focus(0.45, 0.45, lerp(1.2, 1.7, inOut(u / sw))) } else { s.dev.show('deploys', span(u, sw, d, 0.5, 8.5)); s.dev.focus(0.42, 0.28, lerp(1.6, 1.35, inOut((u - sw) / (d - sw)))) }
    },
    extra: {
      build(s) { s.stat = el('div', 'stat', '<b>35 min</b><span>first prompt → live app</span><small>from the Claude Code session log</small>', s.root) },
      draw(s, t, u, d) { pop(s.stat, t, s.start + d - 2.2, { y: 40, s: 0.6 }); css(s.stat, { left: '1260px', top: '760px' }) }
    } })

  S.outro = {
    build(s) {
      s.row = el('div', 'logorow', `<div class="lg"><span class="cc">Claude Code</span></div><div class="lg"><img class="inv" src="${D.brand.viasocket}" style="height:64px"></div><div class="lg"><img class="inv" src="${D.brand.embarko}" style="height:58px;border-radius:12px"><span class="emb">Embarko</span></div>`, s.root)
      s.lbl = [...s.row.children]
      s.lat = [at('built', 'claude'), at('built', 'via'), at('built', 'embarko')]
      s.lock = el('div', 'lockup', `${LOGO(120)}<span>DealSaathi</span>`, s.root)
      s.tag = el('div', 'tagline', 'Find, show and agree on property,<br>with your agent alongside.', s.root)
      s.url = el('div', 'urlrow', '<span class="urlpill">dealsaathi-app.embarko.app</span>', s.root)
      css(s.url, { top: '800px' })
      s.laptop = el('div', 'laptop', '<img>', s.root)
      s.limg = s.laptop.querySelector('img')
      s.tLock = at('tagline', 'deal'), s.tTag = at('tagline', 'find')
    },
    draw(s, t, u, d) {
      s.lbl.forEach((x, i) => pop(x, t, s.lat[i] - 0.1, { y: 40, s: 0.6 }))
      const up = inOut((t - s.tLock + 0.3) / 0.6)
      css(s.row, { top: `${lerp(470, 120, up)}px`, transform: `translateX(-50%) scale(${lerp(1, 0.62, up)})` })
      pop(s.lock, t, s.tLock - 0.2, { y: 50, s: 0.7 }); s.lock.style.transform += ''
      pop(s.tag, t, s.tTag - 0.1, { y: 30, s: 0.95 })
      pop(s.url, t, s.tTag + 1.2, { y: 20, s: 0.9 })
      const endAt = L.tagline.end + 0.6
      const lp = clamp((t - endAt) / 0.8)
      css(s.laptop, { opacity: String(lp) })
      for (const e of [s.row, s.lock, s.tag, s.url]) e.style.opacity = String(Math.min(Number(e.style.opacity || 1), 1 - clamp((t - endAt + 0.3) / 0.5)))
      if (lp > 0) setImg(s.limg, frameSrc('laptop', clamp(t - endAt + 1.5, 0, 15)))
    }
  }


  // ---------- showcase shots (the reference-style 3-minute film) ----------
  const SERIF = (x) => `<em class="serif">${x}</em>`
  const beat = (id) => D.plan.beats.find((b) => b.id === id)

  S.essentials = {
    build(s) {
      s.k = el('div', 'pk centerk', 'What’s inside', s.root)
      s.h = el('div', 'ess-h', `One workspace, ${SERIF('every side of the deal.')}`, s.root)
      s.cards = [['recommendations', 'Matches with reasons', 'Buyers see why a listing fits them'], ['offers', 'Offers and counters', 'Agent forwards, owner answers'], ['viewings', 'Viewings in your calendar', 'Booked into Google Calendar'], ['assistant', 'AI lead entry', 'Describe it; AI fills the details']]
        .map(([ic, a, b], i) => { const c = el('div', 'ess-card', `<div class="gi">${ICON(D.icons[ic], 40, '#6ee7b7')}</div><b>${a}</b><span>${b}</span>`, s.root); css(c, { left: `${150 + i * 410}px`, top: '560px' }); return c })
    },
    draw(s, t, u, d, out) {
      css(s.k, { left: '0', right: '0', top: '250px' }); pop(s.k, t, s.start + 0.1, { y: 20, s: 0.95 })
      pop(s.h, t, s.start + 0.25, { y: 40, s: 0.92 })
      s.cards.forEach((c, i) => pop(c, t, s.start + 1.2 + i * 0.55, { y: 70, s: 0.8, d: 0.5 }))
      css(s.root, { opacity: String(1 - out), transform: `translateY(${-out * 60}px)` })
    }
  }

  S.vsTitle = {
    build(s) {
      s.frame = el('div', 'stillframe', `<img src="${D.stills.viasocket}">`, s.root)
      s.logo = el('div', 'vs-logo', `<img class="inv" src="${D.brand.viasocket}">`, s.root)
      s.sub = el('div', 'vs-sub', 'Integrations · AI · connected apps, behind one SDK', s.root)
    },
    draw(s, t, u, d, out) {
      const e = outCubic(u / 1.2)
      css(s.frame, { opacity: String(0.28 * clamp(u / 0.6)), transform: `scale(${lerp(1.15, 1.04, e)})`, filter: 'blur(3px)' })
      pop(s.logo, t, s.start + 0.2, { y: 30, s: 0.8, d: 0.6 })
      pop(s.sub, t, s.start + 0.8, { y: 20, s: 0.95 })
      css(s.root, { opacity: String(1 - out), transform: `scale(${1 + out * 0.08})` })
    }
  }

  S.claudeW = productShot({ id: 'w_claude', kicker: 'The build', head: 'One prompt in Claude Code', url: 'claude.ai/code', w: 1180, top: 210, ratio: 958 / 1920,
    subs: [['A single, detailed prompt', 'detailed'], ['Refined with follow-ups', 'refined']],
    play(s, t, u, d) { s.dev.show('claude', span(u, 0, d, 0.2, 15.5)); s.dev.focus(0.3, 0.3, lerp(1.0, 1.4, inOut((u - 0.6) / (d - 0.6)))) } })

  S.sdk = {
    build(s) {
      s.text = el('div', 'ptext', '<div class="pk">The integration</div><div class="ph">viaSocket SDK</div><div class="ps">The skill: one setup prompt</div><div class="ps">The SDK: one client on the server</div><div class="ps">No connector built from scratch</div>', s.root)
      css(s.text, { left: '110px', width: '600px' })
      s.persp = el('div', 'persp', '', s.root)
      s.dev = el('div', 'dev', `<div class="bar"><i></i><i></i><i></i><span>viasocket.com</span></div><div class="scr" style="height:${Math.round(1120 * 940 / 1903)}px"><div class="zoomer"><img src="${D.stills.viasocket}"></div></div>`, s.persp)
      css(s.dev, { width: '1120px' })
      css(s.persp, { left: '720px', top: '200px' })
      s.zoomer = s.dev.querySelector('.zoomer')
      s.skill = el('div', 'codecard sm', `<div class="cbar"><i></i><i></i><i></i><span>viasocket-integrations/SKILL.md</span></div><pre>${D.skill.map((x) => x.replace(/</g, '&lt;')).join('\n')}</pre>`, s.root)
      s.code = el('div', 'codecard sm', `<div class="cbar"><i></i><i></i><i></i><span>server/viasocket.js</span></div><pre>${D.code.map((x) => x.replace(/</g, '&lt;').replace(/(ViaSocket|runAction)/g, '<em>$1</em>').replace(/('[^']*')/g, '<q>$1</q>')).join('\n')}</pre>`, s.root)
      s.tSkill = at('w_sdk', 'skill'), s.tWithout = at('w_sdk', 'without')
    },
    draw(s, t, u, d, out) {
      const k = s.text.children
      pop(k[0], t, s.start + 0.1, { y: 20, s: 0.95 }); pop(k[1], t, s.start + 0.2, { y: 40, s: 0.9 })
      pop(k[2], t, s.tSkill - 0.1); pop(k[3], t, s.tSkill + 2.2); pop(k[4], t, s.tWithout - 0.1)
      const cut = s.tSkill + 1.4
      const e = outCubic(u / 0.7)
      css(s.persp.firstChild, { transform: `perspective(2200px) rotateY(${lerp(28, 7, e)}deg) translateX(${(1 - e) * 400}px)`, opacity: String(clamp(u / 0.35) * (1 - clamp((t - cut) / 0.4))) })
      const z = lerp(1.0, 2.1, inOut((u - 0.4) / 1.6)), W2 = 1120, H2 = Math.round(1120 * 940 / 1903)
      css(s.zoomer, { transform: `translate(${clamp(W2 / 2 - 0.2 * W2 * z, W2 - W2 * z, 0)}px, ${clamp(H2 / 2 - 0.58 * H2 * z, H2 - H2 * z, 0)}px) scale(${z})` })
      const p1 = outBack(prog(t, cut, 0.55)), p2 = outBack(prog(t, cut + 0.7, 0.55))
      css(s.skill, { left: '720px', top: '170px', opacity: String(clamp(p1 * 2)), transform: `translateY(${(1 - p1) * 80}px)` })
      css(s.code, { left: '980px', top: '520px', opacity: String(clamp(p2 * 2)), transform: `translateY(${(1 - p2) * 80}px)` })
      css(s.root, { opacity: String(1 - out), transform: `translateX(${-out * 160}px)` })
    }
  }

  S.hub = {
    build(s) {
      s.k = el('div', 'pk centerk', 'One SDK in the middle', s.root)
      s.svg = el('div', 'hubsvg', '', s.root)
      const nodes = [['Gmail', -1, -1], ['Slack', 1, -1], ['Google Calendar', -1, 1], ['AI', 1, 1]]
      s.nodes = nodes.map(([n, x, y]) => { const e = el('div', 'hubnode', n, s.root); e.pos = [960 + x * 520, 560 + y * 230]; return e })
      s.center = el('div', 'hubcenter', `${LOGO(110)}<span>DealSaathi</span>`, s.root)
      s.ring = el('div', 'hubring', '<span>viaSocket SDK</span>', s.root)
      s.tail = el('div', 'hubtail', `…and the tools ${SERIF('around it.')}`, s.root)
    },
    draw(s, t, u, d, out) {
      css(s.k, { left: '0', right: '0', top: '120px' }); pop(s.k, t, s.start + 0.1, { y: 20, s: 0.95 })
      pop(s.center, t, s.start + 0.15, { y: 0, s: 0.6 })
      const rp = outBack(prog(t, s.start + 0.5, 0.6)); css(s.ring, { opacity: String(clamp(rp * 2)), transform: `translate(-50%,-50%) scale(${lerp(0.6, 1, rp)}) rotate(${t * 6}deg)` })
      let lines = ''
      s.nodes.forEach((n, i) => {
        const p = outCubic(prog(t, s.start + 0.9 + i * 0.35, 0.5))
        css(n, { left: `${n.pos[0]}px`, top: `${n.pos[1]}px`, opacity: String(p), transform: `translate(-50%,-50%) scale(${lerp(0.7, 1, p)})` })
        const [x, y] = n.pos, cx = 960, cy = 560
        lines += `<line x1="${cx}" y1="${cy}" x2="${lerp(cx, x, p)}" y2="${lerp(cy, y, p)}" stroke="#34d399" stroke-opacity=".55" stroke-width="3" stroke-dasharray="10 10" stroke-dashoffset="${-t * 40}"/>`
      })
      s.svg.innerHTML = `<svg width="1920" height="1080">${lines}</svg>`
      pop(s.tail, t, s.start + d - 2.2, { y: 20, s: 0.95 })
      css(s.root, { opacity: String(1 - out) })
    }
  }

  S.half = {
    build(s) { s.h = el('div', 'bigline', `Building it is only ${SERIF('half the job.')}`, s.root) },
    draw(s, t, u, d, out) { pop(s.h, t, s.start + 0.2, { y: 40, s: 0.92 }); css(s.root, { opacity: String(1 - out), filter: `blur(${out * 8}px)` }) }
  }

  S.getOnline = {
    build(s) { s.k = el('div', 'pk centerk', 'The next step', s.root); s.h = el('div', 'bigline', `Get it ${SERIF('online.')}`, s.root); s.sub = el('div', 'bigsub', 'From a project to a URL anyone can open.', s.root) },
    draw(s, t, u, d, out) {
      css(s.k, { left: '0', right: '0', top: '360px' }); pop(s.k, t, s.start + 0.05, { y: 20, s: 0.95 })
      pop(s.h, t, s.start + 0.2, { y: 50, s: 0.85 }); pop(s.sub, t, s.start + 0.7, { y: 20, s: 0.95 })
      css(s.root, { opacity: String(1 - out), transform: `scale(${1 + out * 0.1})` })
    }
  }

  S.embHome = {
    build(s) {
      s.text = el('div', 'ptext', '<div class="pk">The hosting</div><div class="ph">Embarko</div><div class="ps">Hosting for apps you build with AI</div><div class="ps">No Dockerfile, no servers</div>', s.root)
      css(s.text, { left: '1260px', width: '600px' })
      s.persp = el('div', 'persp', '', s.root)
      s.dev = el('div', 'dev', `<div class="bar"><i></i><i></i><i></i><span>embarko.ai</span></div><div class="scr" style="height:${Math.round(1120 * 902 / 1918)}px"><div class="zoomer"><img src="${D.stills.embarko}"></div></div>`, s.persp)
      css(s.dev, { width: '1120px' }); css(s.persp, { left: '90px', top: '230px' })
      s.zoomer = s.dev.querySelector('.zoomer')
      s.tE = at('w_embarko', 'embarko')
    },
    draw(s, t, u, d, out) {
      const k = s.text.children
      pop(k[0], t, s.start + 0.1, { y: 20, s: 0.95 }); pop(k[1], t, s.tE - 0.2, { y: 40, s: 0.9 }); pop(k[2], t, s.tE + 0.6); pop(k[3], t, s.tE + 2.0)
      const e = outCubic(u / 0.7)
      css(s.persp.firstChild, { transform: `perspective(2200px) rotateY(${lerp(-28, -7, e)}deg) translateX(${(e - 1) * 400}px)`, opacity: String(clamp(u / 0.35)) })
      const z = lerp(1.0, 1.35, inOut(u / d)), W2 = 1120, H2 = Math.round(1120 * 902 / 1918)
      css(s.zoomer, { transform: `translate(${clamp(W2 / 2 - 0.5 * W2 * z, W2 - W2 * z, 0)}px, ${clamp(H2 / 2 - 0.4 * H2 * z, H2 - H2 * z, 0)}px) scale(${z})` })
      css(s.root, { opacity: String(1 - out), transform: `translateX(${out * 160}px)` })
    }
  }

  S.workflow = productShot({ id: 'w_workflow', kicker: 'Host new app', head: 'Copy. Paste. Deployed.', url: 'embarko.ai/app', w: 1180, top: 210, ratio: 958 / 1920,
    subs: [['Copy Embarko’s hosting prompt', 'hosting'], ['Paste it into Claude Code', 'configuration'], ['The agent handles the deploy', 'agent']],
    play(s, t, u, d) { s.dev.show('host', span(u, 0, d, 1.0, 24.0)); s.dev.focus(0.45, 0.45, lerp(1.15, 1.75, inOut(u / d))) } })

  S.url = {
    build(s) {
      s.term = el('div', 'codecard term', '<div class="cbar"><i></i><i></i><i></i><span>Claude Code · Embarko deploy (real output, 21 Oct 2026)</span></div><pre></pre>', s.root)
      s.lines = D.deployLog
      s.urlp = el('div', 'urlrow', '<span class="urlpill big">dealsaathi-app.embarko.app</span>', s.root)
      s.chips = el('div', 'tagrow', '<div class="chip">No Dockerfile to write</div><div class="chip">Live in seconds</div>', s.root)
      s.tUrl = at('w_url', 'live')
    },
    draw(s, t, u, d, out) {
      const p = outBack(prog(t, s.start + 0.05, 0.5))
      css(s.term, { left: '360px', top: '170px', width: '1200px', opacity: String(clamp(p * 2)), transform: `translateY(${(1 - p) * 60}px)` })
      const shown = Math.floor(clamp((u - 0.4) / 2.6) * s.lines.length + 0.0001)
      s.term.querySelector('pre').innerHTML = s.lines.slice(0, shown).map((x) => x.replace(/</g, '&lt;').replace(/\b(live|success|true)\b/g, '<b class="ok">$1</b>').replace(/\bbuilding\b/g, '<b class="wip">building</b>')).join('\n') + '<span class="caret">▍</span>'
      css(s.urlp, { top: '650px' }); pop(s.urlp, t, s.tUrl - 0.3, { y: 30, s: 0.85 })
      css(s.chips, { top: '780px' }); pop(s.chips, t, s.tUrl + 0.5, { y: 20, s: 0.95 })
      css(s.root, { opacity: String(1 - out) })
    }
  }

  S.edash = {
    build(s) {
      s.text = el('div', 'ptext', '<div class="pk">Running</div><div class="ph">One dashboard</div><div class="ps">Traffic</div><div class="ps">Deployments</div><div class="ps">Scheduled jobs</div>', s.root)
      css(s.text, { left: '110px', width: '560px' })
      s.persp = el('div', 'persp', '', s.root)
      s.dev = el('div', 'dev', `<div class="bar"><i></i><i></i><i></i><span>embarko.ai/app · dealsaathi-app</span></div><div class="scr" style="height:${Math.round(1150 * 945 / 1906)}px"><div class="zoomer"><img src="${D.stills.embarkoDash}"></div></div>`, s.persp)
      css(s.dev, { width: '1150px' }); css(s.persp, { left: '700px', top: '220px' })
      s.zoomer = s.dev.querySelector('.zoomer')
      s.subAt = [at('w_dash', 'traffic'), at('w_dash', 'performance'), at('w_dash', 'scheduled')]
    },
    draw(s, t, u, d, out) {
      const k = s.text.children
      pop(k[0], t, s.start + 0.1, { y: 20, s: 0.95 }); pop(k[1], t, s.start + 0.2, { y: 40, s: 0.9 })
      for (let i = 0; i < 3; i++) pop(k[i + 2], t, s.subAt[i] - 0.1)
      const e = outCubic(u / 0.7)
      css(s.persp.firstChild, { transform: `perspective(2200px) rotateY(${lerp(28, 7, e)}deg) translateX(${(1 - e) * 400}px)`, opacity: String(clamp(u / 0.35)) })
      const W2 = 1150, H2 = Math.round(1150 * 945 / 1906)
      const ph = clamp((t - s.subAt[2] + 0.2) / 1.0)
      const fx = 0.5, fy = lerp(0.42, 0.88, inOut(ph)), z = lerp(1.35, 1.7, inOut(u / d))
      css(s.zoomer, { transform: `translate(${clamp(W2 / 2 - fx * W2 * z, W2 - W2 * z, 0)}px, ${clamp(H2 / 2 - fy * H2 * z, H2 - H2 * z, 0)}px) scale(${z})` })
      css(s.root, { opacity: String(1 - out), transform: `translateX(${-out * 160}px)` })
    }
  }

  S.deployStats = {
    build(s) {
      s.k = el('div', 'pk', 'Embarko deployment history · dealsaathi-app · real record', s.root)
      css(s.k, { left: '120px', top: '110px' })
      const deps = D.deploys.slice().reverse()
      const max = 40
      s.rows = deps.map((x, i) => { const r = el('div', 'drow', `<span class="dv">${x.v}</span><span class="dbar"><i></i></span><span class="ds">${x.secs > 99 ? '9 min*' : `${x.secs} s`}</span><span class="dok">✓</span>`, s.root); css(r, { left: '120px', top: `${170 + i * 38}px` }); r.w = Math.min(1, x.secs / max); return r })
      s.big = el('div', 'bigstat', `<b>${D.deployStats.median} s</b><span>median from upload to live</span>`, s.root)
      s.big2 = el('div', 'bigstat', `<b>${D.deployStats.ok}<small>/${D.deployStats.total}</small></b><span>deployments succeeded</span>`, s.root)
      s.note = el('div', 'dnote', `Source: Embarko deployments API, read ${D.deployStats.read}. *v15 was a settings change made in the Embarko dashboard.`, s.root)
    },
    draw(s, t, u, d, out) {
      pop(s.k, t, s.start + 0.05, { y: 20, s: 0.95 })
      s.rows.forEach((r, i) => { const p = outCubic(prog(t, s.start + 0.2 + i * 0.06, 0.4)); css(r, { opacity: String(p) }); r.querySelector('i').style.width = `${r.w * 100 * outCubic(prog(t, s.start + 0.4 + i * 0.06, 0.6))}%` })
      css(s.big, { left: '1180px', top: '300px' }); pop(s.big, t, s.start + 1.4, { y: 40, s: 0.7 })
      css(s.big2, { left: '1180px', top: '560px' }); pop(s.big2, t, s.start + 2.2, { y: 40, s: 0.7 })
      css(s.note, { left: '120px', top: '960px' }); pop(s.note, t, s.start + 1.0, { y: 10, s: 1 })
      css(s.root, { opacity: String(1 - out) })
    }
  }

  S.sellBuy = productShot({ id: 'w_seller', kicker: 'Live demo', head: 'List in minutes.', url: 'dealsaathi-staging.embarko.app · demo data',
    subs: [['A seller lists a villa', 'seller'], ['A buyer taps “I’m interested”', 'buyer'], ['…and makes an offer', 'offer']],
    play(s, t, u, d) {
      const sw = at('w_seller', 'buyer') - s.start - 0.2
      if (u < sw) { s.dev.show('seller', span(u, 0, sw, 2.2, 28.3)); s.dev.focus(0.55, lerp(0.25, 0.75, inOut(u / sw)), 1.25) } else { s.dev.show('offer', span(u, sw, d * 0.97, 3.0, 28.5)); s.dev.focus(0.5, 0.5, lerp(1.15, 1.3, (u - sw) / (d - sw))) }
    } })

  S.oneFlow = {
    build(s) {
      s.h = el('div', 'chead', `One workflow. ${SERIF('Three roles.')}`, s.root)
      s.cards = [['leads', 'Agent', 'forwards and records'], ['browse', 'Buyer', 'finds, offers, accepts'], ['offers', 'Seller', 'lists and answers']]
        .map(([ic, a, b], i) => { const c = el('div', 'glass small', `<div class="gi">${ICON(D.icons[ic], 46, '#6ee7b7')}</div><div class="gt">${a}</div><div class="gs">${b}</div>`, s.root); css(c, { left: `${250 + i * 520}px`, top: '380px' }); return c })
      s.arrows = [0, 1].map((i) => { const a = el('div', 'arrow', '', s.root); css(a, { left: `${690 + i * 520}px`, top: '540px' }); return a })
    },
    draw(s, t, u, d, out) {
      pop(s.h, t, s.start + 0.1, { y: 30, s: 0.95 })
      s.cards.forEach((c, i) => pop(c, t, s.start + 0.35 + i * 0.4, { y: 70, s: 0.8, d: 0.5 }))
      s.arrows.forEach((a, i) => css(a, { width: `${70 * outCubic(prog(t, s.start + 0.8 + i * 0.4, 0.4))}px` }))
      css(s.root, { opacity: String(1 - out), transform: `scale(${1 + out * 0.06})` })
    }
  }

  S.recap = {
    build(s) {
      s.steps = [['1', 'Build', 'with Claude Code'], ['2', 'Connect', 'apps and AI with the viaSocket SDK'], ['3', 'Host', 'on Embarko, at a live URL']]
        .map(([n, a, b], i) => { const c = el('div', 'stepcard', `<span class="on">${n}</span><b>${a}</b><span>${b}</span>`, s.root); css(c, { left: `${220 + i * 520}px`, top: '360px' }); return c })
      s.arrows = [0, 1].map((i) => { const a = el('div', 'arrow', '', s.root); css(a, { left: `${660 + i * 520}px`, top: '470px' }); return a })
      s.url = el('div', 'urlrow', '<span class="urlpill big">dealsaathi-app.embarko.app</span>', s.root)
      s.cap = el('div', 'bigsub', 'The journey, in one product.', s.root)
    },
    draw(s, t, u, d, out) {
      s.steps.forEach((c, i) => pop(c, t, s.start + 0.15 + i * 0.45, { y: 60, s: 0.8, d: 0.5 }))
      s.arrows.forEach((a, i) => css(a, { width: `${60 * outCubic(prog(t, s.start + 0.5 + i * 0.45, 0.4))}px` }))
      css(s.url, { top: '700px' }); pop(s.url, t, s.start + 1.8, { y: 30, s: 0.85 })
      css(s.cap, { top: '800px' }); pop(s.cap, t, s.start + 2.3, { y: 20, s: 0.95 })
      css(s.root, { opacity: String(1 - out) })
    }
  }

  // ---------- setup & frame ----------
  window.setup = (data) => {
    D = data
    L = Object.fromEntries(D.plan.lines.map((l) => [l.id, l]))
    root = document.getElementById('stage')
    bg = el('div', 'bg', '<b></b><b></b><b></b><div class="grid"></div><div class="vig"></div>')
    shots = D.shots.map((sh, i) => {
      const s = { ...sh, root: el('div', 'shot'), next: D.shots[i + 1] ? D.shots[i + 1].start : D.plan.total }
      s.root.style.display = 'none'
      const saved = root
      root = s.root
      S[sh.kind].build(s)
      root = saved
      return s
    })
    tagEl = el('div', 'demotag', 'Demo data · staging copy of the live release')
    captionsEl = el('div', 'captions')
    return shots.map((s) => ({ kind: s.kind, start: s.start, end: s.next }))
  }

  window.frame = async (t) => {
    pending.length = 0
    drawBg(t)
    for (const s of shots) {
      const live = t >= s.start && t < s.next + 0.32
      s.root.style.display = live ? 'block' : 'none'
      if (!live) continue
      const out = clamp((t - s.next) / 0.32) ** 0.7
      S[s.kind].draw(s, t, t - s.start, s.next - s.start, out)
      s.root.style.zIndex = String(out > 0 ? 1 : 2)
    }
    const cur = shots.find((s) => t >= s.start && t < s.next)
    tagEl.style.opacity = cur && ['dash', 'ai', 'seller', 'buyer', 'offer', 'notify', 'tools', 'sellBuy'].includes(cur.kind) ? '1' : '0'
    drawCaptions(t)
    await Promise.all(pending)
  }
})()

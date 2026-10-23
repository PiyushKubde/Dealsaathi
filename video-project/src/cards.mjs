// Renders the still cards and text overlays of the demo video to 1920×1080 PNGs.
//   node src/cards.mjs            → assets/cards/*.png, assets/overlays/*.png
// Every code card reads the real source file from the DealSaathi repository at the listed lines, and every
// evidence card reads evidence/*.json (captured from the Embarko API and the Claude Code session log).
// Nothing on a card is typed in by hand except titles, labels and the MISSING-asset slates.
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire('/opt/node22/lib/node_modules/')
const { chromium } = require('playwright')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = join(ROOT, '..')
const ev = JSON.parse(readFileSync(join(ROOT, 'evidence/embarko.json'), 'utf8'))
const ses = JSON.parse(readFileSync(join(ROOT, 'evidence/session-excerpts.json'), 'utf8'))
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const file = (p) => readFileSync(join(REPO, p), 'utf8').split('\n')
const img = (p) => `data:image/png;base64,${readFileSync(join(ROOT, p)).toString('base64')}`
const utc = (iso) => iso.slice(11, 19) + ' UTC'
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

// ---------- styles ----------
const BASE = `*{box-sizing:border-box;margin:0;padding:0}html,body{width:1920px;height:1080px;overflow:hidden}
body{font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.mono{font-family:'DejaVu Sans Mono',monospace}
.kicker{font-size:22px;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
.src{position:absolute;left:96px;bottom:54px;font-size:21px}
`
const DARK = `body{background:radial-gradient(1200px 700px at 80% -10%,#12324a 0%,transparent 60%),#0a0f17;color:#e6edf3}
.kicker{color:#5eead4}.src{color:#8b98a8}
.win{background:#0f1622;border:1px solid #223047;border-radius:18px;box-shadow:0 30px 80px -30px rgba(0,0,0,.8);overflow:hidden}
.bar{height:52px;display:flex;align-items:center;gap:10px;padding:0 20px;border-bottom:1px solid #1c2738;background:#0c121c;color:#8b98a8;font-size:20px}
.dot{width:14px;height:14px;border-radius:50%}
.code{font-size:25px;line-height:1.62;padding:22px 0}
.ln{display:flex;padding:0 28px 0 0;white-space:pre;overflow:hidden}
.ln>span:last-child{overflow:hidden;text-overflow:ellipsis;min-width:0}
.ln .n{width:78px;text-align:right;padding-right:26px;color:#4b5a6e;flex:none}
.ln.hl{background:rgba(16,185,129,.13);box-shadow:inset 5px 0 0 #10b981}
.ln.hl .n{color:#5eead4}
.k{color:#ff7b72}.s{color:#a5d6ff}.c{color:#7d8b9c;font-style:italic}.f{color:#d2a8ff}.p{color:#79c0ff}
`
const LIGHT = `body{background:#f6f7f9;color:#0f172a}.kicker{color:#4f46e5}.src{color:#64748b}
.panel{background:#fff;border:1px solid #e2e8f0;border-radius:18px;box-shadow:0 20px 50px -30px rgba(15,23,42,.35)}
`

function highlight(line) {
  let out = ''; let rest = line
  const rules = [[/^(\/\/.*|\/\*.*?\*\/|^\s*\*.*|^\s*\/\*\*.*)/, 'c'], [/^('[^']*'|"[^"]*"|`[^`]*`)/, 's'],
    [/^\b(import|from|export|const|let|async|await|return|function|new|try|catch|if|for|throw|null|true|false)\b/, 'k'],
    [/^\b(ViaSocket|viasocket|runAction|connect|user|catalog|process)\b/, 'p'], [/^[A-Za-z_$][\w$]*(?=\()/, 'f']]
  while (rest.length) {
    let hit = null
    for (const [re, cls] of rules) { const m = rest.match(re); if (m && m[0].length) { hit = [m[0], cls]; break } }
    if (hit) { out += `<span class="${hit[1]}">${esc(hit[0])}</span>`; rest = rest.slice(hit[0].length) } else {
      const m = rest.match(/^[A-Za-z_$][\w$]*|^\s+|^./); out += esc(m[0]); rest = rest.slice(m[0].length)
    }
  }
  return out
}
/** Lines [from, to] of a repo file, numbered as in the file, with `hl` line numbers highlighted. */
function codeBlock(path, ranges, hl = [], { md = false } = {}) {
  const lines = file(path)
  return ranges.map(([a, b], i) => (i ? '<div class="ln"><span class="n">⋮</span></div>' : '') + lines.slice(a - 1, b).map((l, j) => {
    const n = a + j
    return `<div class="ln${hl.includes(n) ? ' hl' : ''}"><span class="n">${n}</span><span>${md ? esc(l) : highlight(l)}</span></div>`
  }).join('')).join('')
}
const win = (title, body, extra = '') => `<div class="win" ${extra}><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span style="margin-left:14px" class="mono">${esc(title)}</span></div>${body}</div>`

// ---------- cards ----------
const ARROW = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
const LOGO = (s = 96) => `<svg width="${s}" height="${s}" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#34d399"/><path d="M8 15.5 16 9l8 6.5V24H8z" fill="#fff"/></svg>`

const CARDS = {
  'c01-title': () => ({ css: `body{background:radial-gradient(1100px 700px at 75% 20%,#0b7a5a 0%,transparent 60%),linear-gradient(135deg,#064e3b,#042f24);color:#f7f5ef}`, html: `
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px">
      ${LOGO(132)}
      <div style="font-size:150px;font-weight:800;letter-spacing:-.035em;line-height:1">DealSaathi</div>
      <div style="font-size:52px;font-weight:500;color:#a7f3d0;letter-spacing:.01em">Build. Integrate. Deploy.</div>
      <div style="margin-top:18px;font-size:28px;color:#d1fae5;opacity:.85">An AI-powered real estate workspace for agents, buyers and sellers</div>
    </div>` }),

  'c02-prompt': () => {
    const p = ses.buildPrompt
    const text = p.excerpt.split('\n').slice(0, 11).join('\n')
    return { css: DARK, html: `
    <div style="position:absolute;left:96px;top:78px" class="kicker">Built with Claude Code · the starting prompt</div>
    <div style="position:absolute;left:96px;top:124px;font-size:56px;font-weight:700;letter-spacing:-.02em">One detailed prompt to start</div>
    <div style="position:absolute;left:96px;right:96px;top:236px">${win(`claude · ${day(p.at)} · ${utc(p.at)}`, `<div class="mono" style="font-size:27px;line-height:1.55;padding:30px 36px;white-space:pre-wrap;color:#e6edf3"><span style="color:#10b981">&gt; </span>${esc(text)}<span style="color:#8b98a8">\n  … (${p.characters.toLocaleString('en')} characters in total)</span></div>`)}</div>
    <div class="src">From the real Claude Code session log (line ${p.line}). The app was then refined over many follow-up prompts in the same session.</div>` }
  },

  'c03-steps': () => {
    const pickSteps = [37, 83, 136, 142, 297, 454].map((n) => ses.steps.find((s) => s.line === n))
    const label = { 37: 'Fetched the ViaSocket skill', 83: 'Installed the ViaSocket SDK', 136: 'Ran ViaSocket’s official check script', 142: 'Checked the embed token', 297: 'First real AI request through ViaSocket', 454: 'Committed and pushed; remote matches local' }
    return { css: DARK, html: `
    <div style="position:absolute;left:96px;top:78px" class="kicker">Built with Claude Code · what happened next</div>
    <div style="position:absolute;left:96px;top:124px;font-size:56px;font-weight:700;letter-spacing:-.02em">The first 27 minutes, from the session log</div>
    <div style="position:absolute;left:96px;right:96px;top:240px;display:grid;gap:18px">
      ${pickSteps.map((s) => `<div style="display:grid;grid-template-columns:200px 1fr;gap:28px;align-items:start;background:#0f1622;border:1px solid #1f2b3d;border-radius:14px;padding:18px 26px">
        <div class="mono" style="font-size:25px;color:#5eead4;padding-top:3px">${utc(s.at).slice(0, 8)}</div>
        <div><div style="font-size:29px;font-weight:600">${esc(label[s.line])}</div>
        <div class="mono" style="font-size:22px;color:#a5d6ff;margin-top:6px;white-space:pre-wrap">${s.output.slice(0, 2).map((o) => esc(o.replace(/\s+—.*$/, '').replace(/\trefs\/heads\/.*/, '').replace(/^(local|remote):\s+(\w{7})\w+/, '$1 $2'))).join('   ')}</div></div></div>`).join('')}
    </div>
    <div class="src">Times are UTC on ${day(pickSteps[0].at)}. Each line is a real tool call and its real output (lines ${pickSteps.map((s) => s.line).join(', ')} of the log).</div>` }
  },

  'c04-skill': () => ({ css: DARK, html: `
    <div style="position:absolute;left:96px;top:78px" class="kicker">Powered by ViaSocket SDK · the skill</div>
    <div style="position:absolute;left:96px;top:124px;font-size:56px;font-weight:700;letter-spacing:-.02em">The ViaSocket skill, in the repository</div>
    <div style="position:absolute;left:96px;right:96px;top:236px">${win('viasocket-integrations/SKILL.md', `<div class="code mono" style="font-size:26px">${codeBlock('viasocket-integrations/SKILL.md', [[1, 3], [9, 18]], [2, 9, 10, 13], { md: true })}</div>`)}</div>
    <div class="src">A pointer file: Claude Code fetches the current skill from ViaSocket every time and follows it.</div>` }),

  'c05-sdk': () => ({ css: DARK, html: `
    <div style="position:absolute;left:96px;top:78px" class="kicker">Powered by ViaSocket SDK · setup</div>
    <div style="position:absolute;left:96px;top:124px;font-size:56px;font-weight:700;letter-spacing:-.02em">One client, created on the server</div>
    <div style="position:absolute;left:96px;right:96px;top:236px">${win('server/viasocket.js', `<div class="code mono" style="font-size:23px">${codeBlock('server/viasocket.js', [[2, 4], [9, 15], [45, 47], [61, 61]], [2, 10, 11, 12, 13, 14, 47, 61])}</div>`)}</div>
    <div class="src">viasocket-apps 0.7.0. The keys come from the server’s environment and never reach the browser.</div>` }),

  'c06-actions': () => ({ css: DARK, html: `
    <div style="position:absolute;left:96px;top:78px" class="kicker">Powered by ViaSocket SDK · connect and run</div>
    <div style="position:absolute;left:96px;top:124px;font-size:56px;font-weight:700;letter-spacing:-.02em">Users connect their apps; the server runs actions</div>
    <div style="position:absolute;left:96px;right:96px;top:222px;display:grid;gap:22px">
      ${win('public/app.js · browser: open the ViaSocket Connect popup', `<div class="code mono" style="font-size:23px;padding:14px 0">${codeBlock('public/app.js', [[903, 909]], [904, 905, 906])}</div>`)}
      ${win('server/integrations/run.js · server: run an action on the user’s connection', `<div class="code mono" style="font-size:23px;padding:14px 0">${codeBlock('server/integrations/run.js', [[1, 2], [163, 166]], [2, 165])}</div>`)}
    </div>
    <div class="src">Real files from the DealSaathi repository, lines as numbered.</div>` }),

  'c07-hosting-prompt': () => {
    const h = ses.hostingPrompt
    return { css: LIGHT, html: `
    <div style="position:absolute;left:96px;top:78px" class="kicker">Hosted on Embarko · the hosting prompt</div>
    <div style="position:absolute;left:96px;top:124px;font-size:56px;font-weight:700;letter-spacing:-.02em">Embarko’s prompt, pasted into Claude Code</div>
    <div class="panel" style="position:absolute;left:96px;right:96px;top:240px;padding:40px 48px">
      <div class="mono" style="font-size:20px;color:#64748b;margin-bottom:18px">${day(h.at)} · ${utc(h.at)} · [first line with the deploy token removed]</div>
      <div style="font-size:31px;line-height:1.55;white-space:pre-wrap">${h.lines.map((l) => esc(l).replace(/(https:\/\/embarko\.ai\/docs\/quickstart\.md)/, '<span style="color:#4f46e5;font-weight:600">$1</span>')).join('\n')}</div>
    </div>
    <div class="src">From the real Claude Code session log (line ${h.line}). The token itself is never shown.</div>` }
  },

  'c08-deploy': () => {
    const first = ses.steps.find((s) => s.line === 665)
    const deps = ev.apps['dealsaathi-app'].deployments
    return { css: LIGHT, html: `
    <div style="position:absolute;left:96px;top:78px" class="kicker">Hosted on Embarko · deployment</div>
    <div style="position:absolute;left:96px;top:124px;font-size:56px;font-weight:700;letter-spacing:-.02em">From a build to a live app</div>
    <div class="panel" style="position:absolute;left:96px;top:240px;width:760px;padding:36px 40px">
      <div style="font-size:24px;font-weight:700;color:#334155">First deploy under the account · ${day(first.at)}</div>
      <div class="mono" style="font-size:27px;line-height:1.75;margin-top:18px">${first.output.map((o) => esc(o).replace(/\blive\b/g, '<b style="color:#059669">live</b>').replace(/building/g, '<span style="color:#d97706">building</span>')).join('<br>')}</div>
      <div style="font-size:21px;color:#64748b;margin-top:20px">Claude Code polled Embarko’s status endpoint (UTC times, session log line ${first.line}).</div>
    </div>
    <div class="panel" style="position:absolute;left:900px;right:96px;top:240px;padding:36px 40px">
      <div style="font-size:24px;font-weight:700;color:#334155">Latest deployments of dealsaathi-app</div>
      <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:25px">
        ${deps.map((d) => `<tr style="border-top:1px solid #e2e8f0"><td style="padding:15px 0;font-weight:700">${esc(d.version)}</td><td class="mono" style="color:#475569">${esc(d.commit.slice(0, 7))}</td><td><span style="background:#ecfdf5;color:#047857;border-radius:99px;padding:4px 14px;font-size:21px;font-weight:600">${esc(d.status)}</span></td><td style="color:#64748b;font-size:21px">${day(d.createdAt)}</td><td>${d.current ? '<span style="background:#4f46e5;color:#fff;border-radius:99px;padding:4px 14px;font-size:20px;font-weight:700">CURRENT</span>' : ''}</td></tr>`).join('')}
      </table>
      <div style="font-size:21px;color:#64748b;margin-top:18px">Each deploy is a git commit; earlier builds stay available for rollback.</div>
    </div>
    <div class="src">Right: Embarko API, read on ${day(ev.capturedAt)} at ${utc(ev.capturedAt).slice(0, 5)} UTC.</div>` }
  },

  'c09-running': () => {
    const a = ev.apps['dealsaathi-app']
    const sc = a.schedules[0]
    const log = a.startupLog.map((l) => l.replace(/ \(\d+ users.*\)$/, '')).filter((l) => !/^Backup|^Access/.test(l))
    return { css: LIGHT, html: `
    <div style="position:absolute;left:96px;top:78px" class="kicker">Deployed and running live</div>
    <div style="position:absolute;left:96px;top:124px;font-size:56px;font-weight:700;letter-spacing:-.02em">dealsaathi-app.embarko.app</div>
    <div class="panel" style="position:absolute;left:96px;top:240px;width:800px;padding:36px 40px">
      <div style="display:flex;align-items:center;gap:16px"><span style="width:18px;height:18px;border-radius:50%;background:#10b981;box-shadow:0 0 0 7px #d1fae5"></span><span style="font-size:36px;font-weight:700">Status: ${esc(a.status.status)}</span><span style="font-size:24px;color:#64748b">· deploy ${esc(a.status.deploy)}</span></div>
      <div style="font-size:24px;font-weight:700;color:#334155;margin-top:34px">Start-up log</div>
      <div class="mono" style="font-size:22px;line-height:1.7;margin-top:10px;color:#1e293b">${log.map(esc).join('<br>')}</div>
    </div>
    <div class="panel" style="position:absolute;left:940px;right:96px;top:240px;padding:36px 40px">
      <div style="font-size:24px;font-weight:700;color:#334155">Scheduled job</div>
      <div style="font-size:30px;font-weight:600;margin-top:14px">${esc(sc.name)}</div>
      <div class="mono" style="font-size:26px;margin-top:16px;line-height:1.7">${esc(sc.cron)} · ${esc(sc.timezone)}<br>POST ${esc(sc.path)}</div>
      <div style="margin-top:22px;font-size:25px">Last run: <b>${esc(utc(sc.lastRun.at).slice(0, 5))} UTC</b> · <span style="color:#047857;font-weight:700">${esc(sc.lastRun.outcome)} ${esc(sc.lastRun.http)}</span></div>
      <div style="font-size:21px;color:#64748b;margin-top:22px">Embarko calls the app every 15 minutes to run follow-up reminders.</div>
    </div>
    <div class="src">Embarko API (status, logs, schedules), read on ${day(ev.capturedAt)} at ${utc(ev.capturedAt).slice(0, 5)} UTC. User counts removed from the log.</div>` }
  },

  'c10-live-tests': () => ({ css: DARK, html: `
    <div style="position:absolute;left:96px;top:78px" class="kicker">Powered by ViaSocket SDK · verified integrations</div>
    <div style="position:absolute;left:96px;top:124px;font-size:56px;font-weight:700;letter-spacing:-.02em">Gmail, Slack and Google Calendar: live tests passed</div>
    <div style="position:absolute;left:96px;top:250px;width:1130px;border-radius:16px;overflow:hidden;border:1px solid #223047;box-shadow:0 30px 80px -30px rgba(0,0,0,.8)"><img src="${img('evidence/screenshots/integrations-live-tests-redacted.png')}" style="width:100%;display:block"></div>
    <div style="position:absolute;left:1290px;right:96px;top:250px;display:grid;gap:22px;font-size:28px;line-height:1.4">
      <div><b style="color:#5eead4">Gmail</b><br>Send test accepted, message id returned.</div>
      <div><b style="color:#5eead4">Slack</b><br>Send test accepted, message ts returned.</div>
      <div><b style="color:#5eead4">Google Calendar</b><br>Send test confirmed later the same day (event created, then deleted).</div>
    </div>
    <div class="src">Screenshot of DealSaathi’s Integrations page in production, 22 Oct 2026 (earlier dark design). E-mail addresses redacted.</div>` }),

  // ---------- MISSING-asset slates: shown until the real recording is dropped in (see asset-manifest.md) ----------
  ...Object.fromEntries([
    ['m01-embarko-host', 'Embarko · “Host new app” page', 'Screen recording: open Embarko’s Host new app page and copy the deployment prompt.', 'recordings/supplied/embarko-host-new-app.mp4'],
    ['m02-claude-paste', 'Claude Code · prompt pasted, deploy running', 'Screen recording: paste the prompt into Claude Code and let the deployment run.', 'recordings/supplied/claude-code-deploy.mp4'],
    ['m03-embarko-dashboard', 'Embarko dashboard · Running, URL, traffic, scheduled jobs', 'Screen recording: the dealsaathi-app dashboard with Running status, production URL, traffic and scheduled jobs.', 'recordings/supplied/embarko-dashboard.mp4'],
    ['m04-claude-build', 'Claude Code · building DealSaathi', 'Optional screen recording of Claude Code at work. The cards before this are real session-log evidence.', 'recordings/supplied/claude-code-build.mp4']
  ].map(([id, title, what, path]) => [id, () => ({ css: `body{background:repeating-linear-gradient(135deg,#111827 0 28px,#151e2e 28px 56px);color:#e5e7eb}`, html: `
    <div style="position:absolute;inset:150px 220px;border:4px dashed #f59e0b;border-radius:28px;display:flex;flex-direction:column;justify-content:center;padding:0 90px;background:rgba(17,24,39,.88)">
      <div style="font-size:30px;font-weight:800;letter-spacing:.16em;color:#f59e0b">MISSING ASSET · PLACEHOLDER</div>
      <div style="font-size:62px;font-weight:700;margin-top:22px;line-height:1.15">${esc(title)}</div>
      <div style="font-size:32px;margin-top:28px;color:#cbd5e1;line-height:1.45">${esc(what)}</div>
      <div class="mono" style="font-size:26px;margin-top:34px;color:#fbbf24">Drop it at video-project/${esc(path)}</div>
    </div>` })])),

  'c11-closing': () => ({ css: `body{background:radial-gradient(1200px 760px at 50% 0%,#0b7a5a 0%,transparent 62%),#04261d;color:#f7f5ef}`, html: `
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px">
      <div style="display:flex;align-items:center;gap:26px">${LOGO(96)}<span style="font-size:84px;font-weight:800;letter-spacing:-.03em">DealSaathi</span></div>
      <div style="font-size:92px;font-weight:800;letter-spacing:-.03em;margin-top:30px">ViaSocket <span style="color:#6ee7b7">×</span> Embarko</div>
      <div style="font-size:50px;font-weight:500;color:#a7f3d0">Build. Integrate. Deploy.</div>
    </div>
    <div style="position:absolute;left:0;right:0;bottom:46px;text-align:center;font-size:22px;color:#fbbf24">Placeholder closing card (text only, no logos) · replace with the supplied graphic at assets/supplied/closing.png</div>` })
}

// ---------- overlays (transparent) ----------
const chip = (text, sub, { pos = 'bl', tone = 'dark' } = {}) => {
  const place = { bl: 'left:96px;bottom:300px', tl: 'left:96px;top:70px', tr: 'right:96px;top:70px', br: 'right:96px;bottom:300px' }[pos]
  const look = tone === 'light' ? 'background:rgba(255,255,255,.96);color:#064e3b;border:1px solid rgba(6,95,70,.18)' : 'background:rgba(6,40,31,.92);color:#f7f5ef;border:1px solid rgba(110,231,183,.25)'
  return `<div style="position:absolute;${place};${look};border-radius:18px;padding:22px 34px;box-shadow:0 24px 60px -24px rgba(0,0,0,.55);max-width:1100px">
    <div style="font-size:46px;font-weight:750;letter-spacing:-.015em">${esc(text)}</div>${sub ? `<div style="font-size:27px;margin-top:6px;opacity:.85">${esc(sub)}</div>` : ''}</div>`
}
const step = (n, text) => `<div style="position:absolute;right:72px;top:40px;background:rgba(6,40,31,.93);color:#f7f5ef;border-radius:16px;padding:16px 26px;display:flex;align-items:center;gap:18px;box-shadow:0 20px 50px -24px rgba(0,0,0,.6)">
  <span style="width:46px;height:46px;border-radius:50%;background:#10b981;color:#04261d;font-weight:800;font-size:26px;display:flex;align-items:center;justify-content:center">${n}</span><span style="font-size:32px;font-weight:650">${esc(text)}</span></div>`
const tag = (text) => `<div style="position:absolute;left:24px;bottom:22px;background:rgba(15,23,42,.78);color:#e2e8f0;border-radius:10px;padding:8px 16px;font-size:20px;font-weight:600">${esc(text)}</div>`
const OVERLAYS = {
  'o-title': () => chip('DealSaathi', 'Build. Integrate. Deploy.'),
  'o-claude': () => chip('Built with Claude Code'),
  'o-viasocket': () => chip('Powered by ViaSocket SDK', 'Gmail · Slack · Google Calendar, connected per user'),
  'o-embarko': () => chip('Hosted on Embarko', null, { tone: 'light' }),
  'o-live': () => chip('Deployed and running live', 'https://dealsaathi-app.embarko.app', { tone: 'light' }),
  'o-prod-url': () => `${chip('Production · signed-out landing page', 'https://dealsaathi-app.embarko.app', { pos: 'br', tone: 'light' })}`,
  'o-staging': () => tag('Staging copy of the same release · synthetic demo accounts and listings'),
  'o-step1': () => step(1, 'Seller lists a villa') + tag('Staging copy of the same release · synthetic demo accounts and listings'),
  'o-step2': () => step(2, 'Buyer: “I’m interested”, then an offer') + tag('Staging copy of the same release · synthetic demo accounts and listings'),
  'o-step3': () => step(3, 'Buyer’s agent forwards it to the owner') + tag('Staging copy of the same release · synthetic demo accounts and listings'),
  'o-step4': () => step(4, 'Owner counters at ₹90 L') + tag('Staging copy of the same release · synthetic demo accounts and listings'),
  'o-step5': () => step(5, 'Buyer accepts in principle') + tag('Staging copy of the same release · synthetic demo accounts and listings'),
  'o-step6': () => step(6, 'Agent records the outcome; everyone is notified') + tag('Staging copy of the same release · synthetic demo accounts and listings'),
  'o-draft': () => `<div style="position:absolute;right:28px;bottom:24px;background:rgba(180,83,9,.9);color:#fff;border-radius:10px;padding:8px 16px;font-size:20px;font-weight:700;letter-spacing:.06em">DRAFT · NO VOICE YET · TEMPORARY TIMING</div>`
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
for (const d of ['assets/cards', 'assets/overlays']) mkdirSync(join(ROOT, d), { recursive: true })
const only = process.argv[2]?.split(',')
for (const [id, make] of Object.entries(CARDS)) {
  if (only && !only.includes(id)) continue
  const { css, html } = make()
  await page.setContent(`<!doctype html><html><head><style>${BASE}${css}</style></head><body>${html}</body></html>`)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(ROOT, 'assets/cards', `${id}.png`) })
}
for (const [id, make] of Object.entries(OVERLAYS)) {
  if (only && !only.includes(id)) continue
  await page.setContent(`<!doctype html><html><head><style>${BASE}html,body{background:transparent}</style></head><body>${make()}</body></html>`)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(ROOT, 'assets/overlays', `${id}.png`), omitBackground: true })
}
await browser.close()
console.log(`cards: ${Object.keys(CARDS).length}, overlays: ${Object.keys(OVERLAYS).length}${existsSync(join(ROOT, 'assets/supplied/closing.png')) ? ' (supplied closing graphic found; build.py uses it)' : ''}`)

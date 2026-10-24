// Renders the launch film's picture: motion.js drawn in Chromium, one screenshot per frame.
//   node src/launch/render.mjs [--from s] [--to s] [--workers 4] [--preview 3,14,40]
// Needs out/launch/plan.json (voice_plan.py) and out/launch/clips (prep_clips.py).
// Writes out/launch/frames/f00001.jpg… and out/launch/shots.json (cut times, used by music.py).
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const require = createRequire('/opt/node22/lib/node_modules/')
const { chromium } = require('playwright')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FILM = process.env.FILM || 'launch'  // launch (1:44) or showcase (~3 min)
const OUT = join(ROOT, 'out', FILM)
const CLIPS = join(ROOT, 'out/launch/clips')
const FPS = 30
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d)
const plan = JSON.parse(readFileSync(join(OUT, 'plan.json'), 'utf8'))
const L = Object.fromEntries(plan.lines.map((l) => [l.id, l]))
const B = Object.fromEntries((plan.beats || []).map((b) => [b.id, b]))

// When each shot starts: on (or just before) the sentence it carries.
const showcaseShots = () => [
  ['hook1', 0], ['hook2', L.hook2.start - 0.3], ['reveal', L.reveal.start - 0.5], ['dash', L.dash.start - 1.1], ['ai', L.ai.start - 0.3],
  ['essentials', B.essentials.start - 0.2], ['vsTitle', B.vsTitle.start - 0.2], ['claudeW', L.w_claude.start - 0.3], ['sdk', L.w_sdk.start - 0.3],
  ['tools', L.tools.start - 0.3], ['hub', L.w_goal.start - 0.3], ['half', L.w_half.start - 0.3], ['getOnline', B.getOnline.start - 0.2],
  ['embHome', L.w_online.start - 0.3], ['workflow', L.w_workflow.start - 0.3], ['url', L.w_url.start - 0.3], ['edash', L.w_dash.start - 0.3],
  ['deployStats', B.deployStats.start - 0.2], ['live', L.live.start - 0.3], ['sellBuy', L.w_action.start - 0.3], ['offer', L.w_forward.start - 0.3],
  ['notify', L.notify.start - 0.3], ['oneFlow', L.w_one.start - 0.3], ['recap', B.recap.start - 0.2], ['outro', L.built.start - 0.5]
]
const shots = (FILM === 'showcase' ? showcaseShots() : [
  ['hook1', 0], ['hook2', L.hook2.start - 0.3], ['reveal', L.reveal.start - 0.5], ['dash', L.dash.start - 1.1],
  ...['ai', 'seller', 'buyer', 'offer', 'notify', 'tools', 'live'].map((k) => [k, L[k].start - 0.3]),
  ['buildTitle', L.live.end + 0.6], ...['claude', 'viasocket', 'embarko'].map((k) => [k, L[k].start - 0.3]), ['outro', L.built.start - 0.5]
]).map(([kind, start]) => ({ kind, start: Math.round(start * 1000) / 1000 }))

const clipBase = pathToFileURL(CLIPS).href
const clipFrames = Object.fromEntries(readdirSync(CLIPS).map((n) => [n, readdirSync(join(CLIPS, n)).filter((f) => f.endsWith('.jpg')).length]))
const appJs = readFileSync(join(ROOT, '..', 'public/app.js'), 'utf8')
const icons = Object.fromEntries(['leads', 'browse', 'offers', 'notifications', 'assistant', 'integrations', 'recommendations', 'viewings'].map((k) => [k, (appJs.match(new RegExp(`\\n  '?${k}'?: '([^']+)'`)) || [])[1]]))
const src = readFileSync(join(ROOT, '..', 'server/viasocket.js'), 'utf8').split('\n')
const code = [src[1], '', ...src.slice(8, 15), src[60].trim()]  // real lines 2, 9–15 and 61 of server/viasocket.js
const svg = (p) => `data:image/svg+xml;base64,${readFileSync(join(ROOT, p)).toString('base64')}`
const fileUrl = (p) => pathToFileURL(join(ROOT, p)).href
const skillMd = readFileSync(join(ROOT, '..', 'viasocket-integrations/SKILL.md'), 'utf8').split('\n')
const skill = [...skillMd.slice(0, 3), '', ...skillMd.slice(8, 14)].map((x) => (x.length > 70 ? x.slice(0, 68) + '…' : x))  // real lines 1–3, 9–14
const ses = JSON.parse(readFileSync(join(ROOT, 'evidence/session-excerpts.json'), 'utf8'))
const poll = (n) => ses.steps.find((x) => x.line === n).output
const deployLog = ['# first deploy, polling Embarko for status', ...poll(615), '', '# redeploy under the account, with the deploy token', ...poll(665)]
const dep = JSON.parse(readFileSync(join(ROOT, 'evidence/embarko-deployments.json'), 'utf8'))
const secs = dep.deployments.map((x) => x.secs).sort((a, b) => a - b)
const deployStats = { median: Math.round((secs[Math.floor((secs.length - 1) / 2)] + secs[Math.ceil((secs.length - 1) / 2)]) / 2), ok: dep.deployments.filter((x) => x.status === 'success').length, total: dep.deployments.length, read: new Date(dep.capturedAt).toUTCString().slice(5, 16) }
const data = { plan, shots, clipBase, clipFrames, icons, code, skill, deployLog, deploys: dep.deployments, deployStats,
  stills: { viasocket: fileUrl('recordings/supplied/viasocket-home.png'), embarko: fileUrl('recordings/supplied/embarko-home.png'), embarkoDash: fileUrl('recordings/supplied/embarko-dashboard.png') },
  brand: { viasocket: svg('assets/brand/viasocket-logo.svg'), embarko: svg('assets/brand/embarko-icon.svg') } }

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}html,body{width:${1920}px;height:${1080}px;overflow:hidden;background:#04110c}
body{font-family:Inter,sans-serif;color:#f4f7f5;-webkit-font-smoothing:antialiased}
#stage{position:absolute;inset:0;overflow:hidden}
.bg{position:absolute;inset:0}.bg b{position:absolute;border-radius:50%;filter:blur(90px)}
.bg b:nth-child(1){width:1100px;height:900px;left:-200px;top:-260px;background:radial-gradient(circle,#0f8f63 0%,transparent 65%);opacity:.75}
.bg b:nth-child(2){width:1000px;height:900px;right:-260px;bottom:-320px;background:radial-gradient(circle,#0e6aa8 0%,transparent 65%);opacity:.45}
.bg b:nth-child(3){width:800px;height:700px;left:700px;top:300px;background:radial-gradient(circle,#5b3fd1 0%,transparent 65%);opacity:.22}
.bg .grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:64px 64px;mask-image:radial-gradient(ellipse at center,#000 30%,transparent 80%)}
.bg .vig{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 50%,rgba(0,0,0,.55) 100%)}
.shot{position:absolute;inset:0}
.shot>*{position:absolute}
.giant{font-size:168px;font-weight:900;letter-spacing:-.045em;line-height:1}
.kicker-c{font-size:26px;font-weight:700;letter-spacing:.3em;text-transform:uppercase;color:#6ee7b7}
.hookkick{font-size:46px;font-weight:850;letter-spacing:.16em;color:#a7f3d0}
.bubble{left:0;top:0;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.14);backdrop-filter:blur(6px);border-radius:22px 22px 22px 6px;padding:16px 22px;font-size:26px;color:#e6f2ec;max-width:420px;box-shadow:0 20px 40px -20px rgba(0,0,0,.6)}
.bubble b{display:block;font-size:17px;color:#6ee7b7;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}
.glass{width:500px;height:330px;padding:38px;border-radius:30px;background:linear-gradient(160deg,rgba(255,255,255,.12),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.16);box-shadow:0 40px 80px -40px rgba(0,0,0,.8)}
.glass .gi{width:86px;height:86px;border-radius:22px;background:rgba(16,185,129,.16);display:flex;align-items:center;justify-content:center}
.glass .gt{font-size:62px;font-weight:850;letter-spacing:-.03em;margin-top:26px}.glass .gs{font-size:30px;color:#b9cfc5;margin-top:8px;line-height:1.3}
.glass .badge{position:absolute;top:30px;right:30px;min-width:52px;height:52px;border-radius:26px;background:#ef4444;color:#fff;font-weight:800;font-size:26px;display:flex;align-items:center;justify-content:center;padding:0 14px;box-shadow:0 0 0 6px rgba(239,68,68,.2)}
.flash{inset:0;background:radial-gradient(circle at 50% 45%,#d1fae5,#10b981 40%,transparent 75%)}
.ring{left:50%;top:48%;width:420px;height:420px;border-radius:50%;border:4px solid #6ee7b7}
.rlogo{left:50%;top:520px;filter:drop-shadow(0 0 60px rgba(52,211,153,.6))}
.rkick{left:0;right:0;top:150px;text-align:center;font-size:28px;font-weight:700;letter-spacing:.42em;color:#6ee7b7}
.rname{left:0;right:0;top:470px;text-align:center;font-size:190px;font-weight:900;letter-spacing:-.05em;line-height:1}
.rsub{left:0;right:0;top:700px;text-align:center;font-size:46px;font-weight:500;color:#d1fae5}
.chip{top:800px;padding:14px 30px;border-radius:999px;background:rgba(16,185,129,.18);border:1px solid rgba(110,231,183,.45);font-size:30px;font-weight:700;color:#d1fae5}
.chip.big{font-size:36px;padding:18px 36px}
.ptext{top:250px}.pk{font-size:24px;font-weight:800;letter-spacing:.28em;text-transform:uppercase;color:#6ee7b7}
.ph{font-size:96px;font-weight:900;letter-spacing:-.04em;line-height:1.02;margin-top:18px}
.ps{font-size:36px;font-weight:600;color:#d7e8df;margin-top:22px;padding-left:46px;position:relative;line-height:1.25}
.ps:before{content:'';position:absolute;left:0;top:10px;width:24px;height:24px;border-radius:50%;background:#10b981;box-shadow:0 0 0 6px rgba(16,185,129,.2)}
.persp{}
.dev{border-radius:20px;overflow:hidden;background:#0d1512;border:1px solid rgba(255,255,255,.14);box-shadow:0 60px 120px -40px rgba(0,0,0,.85),0 0 0 1px rgba(16,185,129,.12),0 0 120px -30px rgba(16,185,129,.45);transform-origin:50% 50%}
.dev .bar{height:46px;display:flex;align-items:center;gap:9px;padding:0 18px;background:#121c18;border-bottom:1px solid rgba(255,255,255,.08)}
.dev .bar i{width:13px;height:13px;border-radius:50%;background:#ff5f57}.dev .bar i:nth-child(2){background:#febc2e}.dev .bar i:nth-child(3){background:#28c840}
.dev .bar span{margin-left:16px;font-size:18px;color:#9fb5ab;background:rgba(255,255,255,.06);padding:5px 16px;border-radius:999px;font-family:'DejaVu Sans Mono',monospace}
.dev .scr{position:relative;overflow:hidden;background:#f7f5ef}.dev .zoomer{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:0 0}.dev img{width:100%;height:100%;object-fit:cover;object-position:top left;display:block}
.spark{filter:drop-shadow(0 0 30px rgba(52,211,153,.7))}
.chead{left:0;right:0;top:120px;text-align:center;font-size:72px;font-weight:900;letter-spacing:-.035em}
.ocol{width:540px}.otitle{font-size:34px;font-weight:800;display:flex;align-items:center;gap:14px;margin-bottom:12px}
.otitle .on{width:46px;height:46px;border-radius:50%;background:#10b981;color:#04261d;display:flex;align-items:center;justify-content:center;font-size:24px}
.ochip{display:inline-block;margin-bottom:18px;padding:8px 20px;border-radius:999px;background:#f7f5ef;color:#065f46;font-weight:800;font-size:26px}
.arrow{height:6px;border-radius:3px;background:linear-gradient(90deg,#10b981,#6ee7b7);box-shadow:0 0 20px #10b981}
.toast2{width:640px;display:flex;gap:18px;align-items:center;background:#f7f5ef;color:#0f172a;border-radius:18px;padding:18px 22px;box-shadow:0 30px 60px -20px rgba(0,0,0,.7)}
.toast2 b{display:block;font-size:26px}.toast2 span{font-size:20px;color:#475569}
.apptile{display:flex;align-items:center;gap:16px;padding:16px 26px 16px 16px;border-radius:20px;background:#fff;color:#0f172a;font-size:30px;font-weight:800;box-shadow:0 30px 60px -24px rgba(0,0,0,.7)}
.apptile i{width:56px;height:56px;border-radius:14px;color:#fff;font-style:normal;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:900}
.livedot{left:430px;top:208px;width:46px;height:46px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 14px rgba(34,197,94,.22),0 0 60px #22c55e}
.livehead{left:510px;top:140px;font-size:170px;font-weight:900;letter-spacing:-.05em;line-height:1}
.urlpill{left:515px;top:350px;font-family:'DejaVu Sans Mono',monospace;font-size:34px;padding:14px 28px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2)}
.btitle{left:0;right:0;top:420px;text-align:center;font-size:150px;font-weight:900;letter-spacing:-.05em}
.shot-card{width:1000px;border-radius:20px;overflow:hidden;border:1px solid rgba(255,255,255,.16);box-shadow:0 50px 100px -40px rgba(0,0,0,.9)}.shot-card img{width:100%;display:block}
.codecard{width:940px;border-radius:20px;overflow:hidden;background:#0b1220;border:1px solid #223047;box-shadow:0 50px 100px -40px rgba(0,0,0,.9)}
.codecard .cbar{height:44px;display:flex;align-items:center;gap:9px;padding:0 18px;background:#0e1626;color:#8b98a8;font-family:'DejaVu Sans Mono',monospace;font-size:18px}
.codecard .cbar i{width:12px;height:12px;border-radius:50%;background:#ff5f57}.codecard .cbar i:nth-child(2){background:#febc2e}.codecard .cbar i:nth-child(3){background:#28c840}.codecard .cbar span{margin-left:12px}
.codecard pre{padding:22px 28px;font-family:'DejaVu Sans Mono',monospace;font-size:24px;line-height:1.6;color:#e6edf3;min-height:420px;white-space:pre}
.codecard em{font-style:normal;color:#79c0ff}.codecard q{quotes:none;color:#a5d6ff}.codecard .caret{color:#34d399}
.stat{padding:22px 30px;border-radius:22px;background:#f7f5ef;color:#064e3b;box-shadow:0 40px 80px -30px rgba(0,0,0,.8)}
.stat b{display:block;font-size:64px;font-weight:900;letter-spacing:-.03em;line-height:1}.stat span{font-size:28px;font-weight:700}.stat small{display:block;font-size:17px;color:#64748b;margin-top:6px}
.logorow{left:50%;top:470px;display:flex;gap:70px;align-items:center;transform:translateX(-50%);transform-origin:50% 50%}
.logorow .lg{display:flex;align-items:center;gap:14px;padding:26px 38px;border-radius:24px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14)}
.logorow .cc{font-size:52px;font-weight:800;letter-spacing:-.02em;white-space:nowrap}.logorow .emb{font-size:56px;font-weight:800;letter-spacing:-.02em}
.logorow img.inv{filter:invert(1) brightness(1.05)}
.lockup{left:0;right:0;top:400px;display:flex;justify-content:center;align-items:center;gap:30px}.lockup span{font-size:150px;font-weight:900;letter-spacing:-.05em}
.tagline{left:0;right:0;top:620px;text-align:center;font-size:52px;font-weight:600;color:#d1fae5;line-height:1.3}
.urlrow{left:0;right:0;text-align:center}.urlrow .urlpill{position:static;display:inline-block}
.tagrow{left:0;right:0;top:640px;display:flex;justify-content:center;gap:24px}.tagrow .chip{position:static}
.serif{font-family:'Liberation Serif','DejaVu Serif',serif;font-style:italic;font-weight:400;letter-spacing:-.01em;color:#a7f3d0}
.centerk{text-align:center}
.ess-h{left:0;right:0;top:320px;text-align:center;font-size:92px;font-weight:850;letter-spacing:-.04em;line-height:1.05}
.ess-card{width:380px;height:250px;padding:30px;border-radius:24px;background:linear-gradient(160deg,rgba(255,255,255,.12),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.16)}
.ess-card .gi{width:72px;height:72px;border-radius:18px;background:rgba(16,185,129,.16);display:flex;align-items:center;justify-content:center}
.ess-card b{display:block;font-size:34px;margin-top:22px;letter-spacing:-.02em}.ess-card span{display:block;font-size:24px;color:#b9cfc5;margin-top:6px}
.stillframe{inset:0}.stillframe img{width:100%;height:100%;object-fit:cover}
.vs-logo{left:0;right:0;top:400px;text-align:center}.vs-logo img{height:150px}
.vs-sub{left:0;right:0;top:620px;text-align:center;font-size:40px;color:#d1fae5;font-weight:500}
img.inv{filter:invert(1) brightness(1.05)}
.codecard.sm{width:880px}.codecard.sm pre{font-size:21px;min-height:0}
.codecard.term pre{font-size:26px;min-height:380px}.codecard b.ok{color:#34d399;font-weight:700}.codecard b.wip{color:#fbbf24;font-weight:700}
.hubsvg{inset:0}
.hubnode{padding:18px 30px;border-radius:999px;background:#f7f5ef;color:#064e3b;font-size:32px;font-weight:800;box-shadow:0 30px 60px -24px rgba(0,0,0,.7)}
.hubcenter{left:0;right:0;top:470px;display:flex;justify-content:center;align-items:center;gap:20px;font-size:56px;font-weight:900;letter-spacing:-.03em;z-index:2}
.hubring{left:960px;top:560px;width:620px;height:620px;border-radius:50%;border:2px dashed rgba(110,231,183,.5)}
.hubring span{position:absolute;left:50%;top:-22px;transform:translateX(-50%);background:#04110c;padding:6px 18px;border-radius:999px;border:1px solid rgba(110,231,183,.5);font-size:24px;font-weight:700;color:#6ee7b7}
.hubtail{left:0;right:0;top:880px;text-align:center;font-size:52px;font-weight:700}
.bigline{left:0;right:0;top:430px;text-align:center;font-size:120px;font-weight:900;letter-spacing:-.045em}
.bigsub{left:0;right:0;top:610px;text-align:center;font-size:40px;color:#d1fae5;font-weight:500}
.urlpill.big{font-size:44px;padding:18px 36px}
.drow{display:flex;align-items:center;gap:18px;width:920px;font-family:'DejaVu Sans Mono',monospace;font-size:20px;color:#cfe3d9}
.drow .dv{width:52px;color:#9fb5ab}.drow .dbar{flex:1;height:12px;border-radius:6px;background:rgba(255,255,255,.07);overflow:hidden}.drow .dbar i{display:block;height:100%;background:linear-gradient(90deg,#10b981,#6ee7b7);border-radius:6px}
.drow .ds{width:90px;text-align:right}.drow .dok{color:#34d399}
.bigstat b{display:block;font-size:150px;font-weight:900;letter-spacing:-.05em;line-height:1}.bigstat b small{font-size:70px;color:#9fb5ab}.bigstat span{font-size:34px;color:#d1fae5;font-weight:600}
.dnote{font-size:19px;color:#9fb5ab}
.glass.small{height:300px}
.stepcard{width:420px;height:230px;padding:30px;border-radius:24px;background:linear-gradient(160deg,rgba(255,255,255,.12),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.16)}
.stepcard .on{display:inline-flex;width:52px;height:52px;border-radius:50%;background:#10b981;color:#04261d;font-weight:900;font-size:26px;align-items:center;justify-content:center}
.stepcard b{display:block;font-size:52px;letter-spacing:-.03em;margin-top:14px}.stepcard span{font-size:26px;color:#b9cfc5}
.laptop{inset:0;background:#000}.laptop img{width:100%;height:100%;object-fit:cover}
.demotag{position:absolute;left:36px;top:30px;font-size:19px;font-weight:600;color:#cfe3d9;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.14);padding:7px 14px;border-radius:999px;z-index:20}
.captions{position:absolute;left:160px;right:160px;bottom:58px;text-align:center;font-size:50px;font-weight:800;letter-spacing:-.01em;line-height:1.25;z-index:30;text-shadow:0 4px 24px rgba(0,0,0,.85),0 2px 4px rgba(0,0,0,.9)}
.cw{display:inline-block;margin:0 .13em}.cw.next{color:rgba(255,255,255,.42)}.cw.said{color:#fff}.cw.now{color:#34d399;transform:scale(1.08)}
`

mkdirSync(join(OUT, 'frames'), { recursive: true })
const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div id="stage"></div><script src="${pathToFileURL(join(ROOT, 'src/launch/motion.js')).href}"></script></body></html>`
writeFileSync(join(OUT, 'stage.html'), html)

const total = plan.total
const from = Number(arg('--from', 0)), to = Number(arg('--to', total))
const preview = arg('--preview', null)
const frames = preview ? preview.split(',').map((s) => Math.round(Number(s) * FPS)) : Array.from({ length: Math.round((to - from) * FPS) }, (_, i) => Math.round(from * FPS) + i)
const workers = Number(arg('--workers', 4))
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] })
let shotTimes
const t0 = Date.now()
let done = 0
await Promise.all(Array.from({ length: workers }, async (_, w) => {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  page.on('pageerror', (e) => console.error('page error:', e.message))
  await page.goto(pathToFileURL(join(OUT, 'stage.html')).href)
  await page.evaluate(() => document.fonts.ready)
  const st = await page.evaluate((d) => window.setup(d), data)
  if (w === 0) shotTimes = st
  for (let i = w; i < frames.length; i += workers) {
    const f = frames[i]
    await page.evaluate((t) => window.frame(t), f / FPS)
    await page.screenshot({ path: join(OUT, preview ? `preview-${String(f).padStart(5, '0')}.jpg` : `frames/f${String(f + 1).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 })
    if (++done % 150 === 0) console.log(`  ${done}/${frames.length} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  }
}))
await browser.close()
writeFileSync(join(OUT, 'shots.json'), JSON.stringify({ total, shots: shotTimes }, null, 1))
console.log(`rendered ${frames.length} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`)

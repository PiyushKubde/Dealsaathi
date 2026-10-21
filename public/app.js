import { api, errorText, field, h, icon, mount, toast } from './lib.js'
import { renderAssistant } from './views/assistant.js'
import { renderDashboard } from './views/dashboard.js'
import { renderIntegrations } from './views/integrations.js'
import { renderLeads } from './views/leads.js'
import { renderProperties } from './views/properties.js'
import { renderRent } from './views/rent.js'
import { renderViewings } from './views/viewings.js'

const ROUTES = [
  { path: 'dashboard', label: 'Dashboard', icon: 'dashboard', render: renderDashboard },
  { path: 'assistant', label: 'AI Assistant', icon: 'assistant', render: renderAssistant },
  { path: 'leads', label: 'Leads', icon: 'leads', render: renderLeads },
  { path: 'viewings', label: 'Viewings', icon: 'viewings', render: renderViewings },
  { path: 'properties', label: 'Property matching', icon: 'properties', render: renderProperties },
  { path: 'rent', label: 'Rent tracking', icon: 'rent', render: renderRent },
  { path: 'integrations', label: 'Integrations', icon: 'integrations', render: renderIntegrations }
]

const app = document.getElementById('app')
const ctx = { user: null, status: null, refreshStatus, navigate }

async function refreshStatus() {
  ctx.status = await api('/status')
  return ctx.status
}

function navigate(path) {
  if (location.hash !== `#/${path}`) location.hash = `#/${path}`
  else route()
}

function currentRoute() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/')
  return { def: ROUTES.find((r) => r.path === name) || ROUTES[0], params: rest }
}

function renderLogin(loginConfigured) {
  const error = h('p', { class: 'field-error', role: 'alert' })
  const form = h('form', { class: 'card stack' },
    h('div', { class: 'brand', style: { padding: 0 } }, h('img', { src: '/favicon.svg', alt: '' }), 'DealSaathi'),
    h('p', { class: 'muted' }, 'Sign in to your real estate workspace.'),
    loginConfigured
      ? [
          field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true })),
          field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
          error,
          h('button', { class: 'primary', type: 'submit' }, 'Sign in')
        ]
      : h('div', { class: 'banner warn' }, h('div', {},
          h('strong', {}, 'Sign-in is not set up yet'),
          'The server needs DEALSAATHI_ADMIN_EMAIL and DEALSAATHI_ADMIN_PASSWORD in its environment.'))
  )
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.textContent = ''
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { email: form.elements.email.value, password: form.elements.password.value } })
      ctx.user = user
      await start()
    } catch (e) {
      error.textContent = errorText(e)
    }
  })
  mount(app, h('div', { class: 'login-wrap' }, h('div', { class: 'login' }, form)))
}

function renderShell() {
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' })
  const nav = h('nav', { class: 'sidebar', 'aria-label': 'Main' },
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'DealSaathi'),
    ROUTES.map((r) => h('a', { class: 'nav-link', href: `#/${r.path}`, 'data-path': r.path }, icon(r.icon), r.label)),
    h('div', { class: 'sidebar-foot' },
      h('div', { class: 'small muted' }, ctx.user.name, h('br'), ctx.user.email),
      h('button', { class: 'small', onclick: async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => {})
        ctx.user = null
        renderLogin(true)
      } }, 'Sign out'))
  )
  const shell = h('div', { class: 'shell' },
    nav,
    h('div', {},
      h('div', { class: 'mobile-bar' },
        h('button', { class: 'small', 'aria-label': 'Open menu', onclick: () => shell.classList.toggle('nav-open') }, '☰ Menu'),
        h('strong', {}, 'DealSaathi'), h('span')),
      main)
  )
  nav.addEventListener('click', (e) => e.target.closest('a') && shell.classList.remove('nav-open'))
  mount(app, shell)
}

let renderToken = 0
async function route() {
  if (!ctx.user) return
  const { def, params } = currentRoute()
  document.querySelectorAll('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.path === def.path))
  document.title = `${def.label} · DealSaathi`
  const main = document.getElementById('main')
  const token = ++renderToken
  mount(main, h('div', { class: 'row muted' }, h('span', { class: 'spinner' }), 'Loading…'))
  try {
    await refreshStatus()
    if (token !== renderToken) return
    const container = h('div')
    await def.render(container, ctx, params)
    if (token === renderToken) mount(main, container)
  } catch (error) {
    if (token === renderToken) mount(main, h('div', { class: 'banner danger' }, h('div', {}, h('strong', {}, 'This page could not load'), errorText(error))))
  }
}

async function start() {
  renderShell()
  if (!location.hash) location.hash = '#/dashboard'
  await route()
}

window.addEventListener('hashchange', route)
window.addEventListener('ds:unauthenticated', () => {
  if (!ctx.user) return
  ctx.user = null
  toast('Your session ended. Sign in again.', 'error')
  renderLogin(true)
})

const me = await api('/auth/me').catch(() => ({ user: null, loginConfigured: true }))
ctx.user = me.user
if (ctx.user) start()
else renderLogin(me.loginConfigured)

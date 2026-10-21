// Time zone arithmetic without a library: wall-clock times in an IANA zone ↔ UTC instants.

/** The 20 zones Google Calendar's viaSocket actions accept (their `timeZone` options). */
export const CALENDAR_TIMEZONES = [
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Moscow', 'Africa/Johannesburg',
  'America/New_York', 'America/Toronto', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Mexico_City', 'America/Sao_Paulo'
]

function parts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]))
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second }
}

/** How far the zone is ahead of UTC at this instant, in milliseconds. */
function offsetAt(ms, timeZone) {
  const p = parts(new Date(ms), timeZone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

/** "2026-10-22" + "16:30" in Asia/Kolkata → Date (UTC instant). Throws on an invalid date or time. */
export function zonedToUtc(date, time, timeZone) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '')
  const t = /^(\d{2}):(\d{2})$/.exec(time || '')
  if (!d || !t) throw new Error('Bad date or time')
  const [y, mo, da, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]]
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) throw new Error('Bad date or time')
  const wall = Date.UTC(y, mo - 1, da, h, mi)
  let guess = wall - offsetAt(wall, timeZone)
  guess = wall - offsetAt(guess, timeZone) // second pass settles daylight-saving edges
  const back = parts(new Date(guess), timeZone)
  if (back.year !== y || back.month !== mo || back.day !== da) throw new Error('Bad date or time')
  return new Date(guess)
}

/** UTC instant → its wall clock in a zone: { date: 'YYYY-MM-DD', time: 'HH:MM', dmy: 'DD-MM-YYYY' }. */
export function utcToZoned(instant, timeZone) {
  const p = parts(new Date(instant), timeZone)
  const pad = (n) => String(n).padStart(2, '0')
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`
  return { date, time: `${pad(p.hour)}:${pad(p.minute)}`, dmy: `${pad(p.day)}-${pad(p.month)}-${p.year}` }
}

export const todayIn = (timeZone, at = new Date()) => utcToZoned(at, timeZone).date

/** 90 → "01:30" (the HH:MM duration Google Calendar's actions take). */
export const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** A human date-time in the zone, for emails: "Thu 22 Oct 2026, 4:30 pm (Asia/Kolkata)". */
export function describeInZone(instant, timeZone) {
  const s = new Intl.DateTimeFormat('en-IN', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(instant))
  return `${s} (${timeZone})`
}

/** Adds days to a 'YYYY-MM-DD' date. */
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)

// Shows context, 5-hour limit, weekly limit and per-model weekly limit usage in the band above
// the prompt.

// The latest figures this session has, from $.session.usage() or session.measure
let context = null
let rateLimits = []
// When rateLimits was last measured, in $.clock.now() milliseconds
let measuredAt = 0
// The timer that refreshes the band, kept so a later session.start can stop it
let ticker = null
// This session's own key in the store
let ownKey = null
// The per-model weekly limits as last read, by this session or another: { at, limits }
let scoped = { at: 0, limits: [] }
// When this session last asked the usage endpoint, whatever came of it
let scopedTriedAt = 0

// Rate limits are per account, so sessions share readings through $.store, and each shows the
// newest one. $.store has no atomic update, so each session writes only its own key, and no
// write can overwrite another session's reading.
// The mods API has no account id, so after switching accounts on this machine a new
// session shows the previous account's reading until its own first response.
const KEY_PREFIX = 'reading:'
// Readings older than the longest window say nothing current: they are never shown, and their
// keys are deleted
const STALE_MS = 8 * 24 * 3_600_000
// The session.end reasons after which this module stops; /clear, /resume (which /branch reports)
// and logout leave it running and measuring
const FINAL_REASONS = ['prompt_input_exit', 'other']
// How often to pick up other sessions' readings and refresh the countdowns and time markers
const TICK_MS = 60_000

// The per-model weekly limits (Fable's), which $.session.usage() and session.measure leave out,
// come from the endpoint /usage reads. Every session shares one key: each write is a whole fresh
// reading, so one landing over another loses nothing.
const SCOPED_KEY = 'scoped'
const SCOPED_URL = 'https://api.anthropic.com/api/oauth/usage'
// How old the shared reading gets before a session asks the endpoint again, and how long a
// session waits after an attempt that brought nothing
const SCOPED_POLL_MS = 5 * 60_000
// A per-model limit that resets within this long of the weekly limit leaves its countdown out
const SAME_RESET_MS = 60_000

const HOUR_MS = 3_600_000
const WINDOWS = {
  // showsClock adds the reset time of day, in JST
  five_hour: { label: '5h', ms: 5 * HOUR_MS, showsClock: true },
  seven_day: { label: '7d', ms: 7 * 24 * HOUR_MS },
  // Labeled with the model's name
  weekly_scoped: { ms: 7 * 24 * HOUR_MS },
  spend_limit: { label: '$' },
}

// Pace thresholds: margin is the elapsed share of the window minus the used share
const GREEN_MIN_MARGIN = 10
const RED_BELOW_MARGIN = -15
// Usage this low stays green early in a window, when the margin is still small
const GREEN_MAX_USED = 10
// Usage this high is red whatever the pace
const RED_MIN_USED = 90

// JST has no daylight saving time, so a fixed offset gives its clock
const JST_OFFSET_MS = 9 * HOUR_MS

const BAR_CELLS = 10
// Columns between two meters, and the band's last column, which the terminal may draw over
const METER_GAP = 3
const BAND_RESERVED_COLUMNS = 2
const SVG_BAR = { width: 96, height: 10 }
// With more meters than this, the Desktop app's bars narrow so the line still fits its band
const SVG_WIDE_MAX_METERS = 3
const SVG_NARROW_WIDTH = 72
const SVG_COLORS = { success: '#4caf50', warning: '#e0a526', error: '#e5534b', track: 'rgba(128,128,128,0.3)', marker: '#5b9bff' }
// The terminal draws the time marker in this color
const MARKER_COLOR = 'cyan'

export function register(on) {
  // Fires again on an enable or a worker respawn, which may keep this module's variables
  on('session.start', async ($, e, next) => {
    ticker?.cancel()
    rateLimits = []
    measuredAt = 0
    scoped = { at: 0, limits: [] }
    scopedTriedAt = 0
    ownKey = KEY_PREFIX + (await $.session.id())
    const usage = await $.session.usage()
    context = usage.context
    if (usage.rateLimits.length > 0) await publishSnapshot($, usage.rateLimits)
    // Also clears keys ended sessions left, which short runs that never tick would not
    await refresh($)
    await adoptScoped($)
    // Not awaited: the session does not wait on the network to start
    void pollScoped($).then(() => $.ui.invalidate('ui.render'))
    ticker = $.clock.every(TICK_MS, async () => {
      await refresh($)
      await adoptScoped($)
      await pollScoped($)
      $.ui.invalidate('ui.render')
    })
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Keeps the store from growing by a key per session. A session whose reading is not the newest
  // removes its own key. One that holds the newest marks it ended, so the others may delete it once
  // a newer reading exists: an ended session never writes again, so that delete can't lose a write.
  on('session.end', async ($, e, next) => {
    if (!FINAL_REASONS.includes(e.reason) || !ownKey) return next(e)
    ticker?.cancel()
    await releaseKey($)
    return next(e)
  })

  // /clear, /resume, /branch (fork) and compaction change the context, which session.measure
  // reports only after the next turn. All but compaction also switch to another session id, so
  // this module hands its key over as an ended session would, and writes under the new id.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork', 'compact'] }, async ($, e, next) => {
    const key = KEY_PREFIX + (await $.session.id())
    if (ownKey && key !== ownKey) {
      await releaseKey($)
      ownKey = key
    }
    context = (await $.session.usage()).context
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Fires after each turn, and when a rate-limit window moves a whole point
  on('session.measure', async ($, e, next) => {
    context = e.context
    // A fresh measurement, including an empty one when the account's windows went away
    if (e.changed.includes('rateLimits')) await remember($, e.rateLimits)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const elements = $.ui.resolve(e)
    const now = await $.clock.now()
    const meters = [{ label: 'ctx', used: context?.percent, elapsed: null, resetsAt: null }]
    for (const limit of rateLimits) {
      meters.push(readLimit(limit, now))
    }
    const weekly = meters.find((m) => m.kind === 'seven_day')
    for (const limit of scoped.limits) {
      const m = readLimit(limit, now)
      // The weekly meter beside it already counts down to the same reset
      if (weekly?.resetsAt != null && m.resetsAt != null && Math.abs(m.resetsAt - weekly.resetsAt) < SAME_RESET_MS) {
        m.resetsAt = null
      }
      meters.push(m)
    }
    for (const m of meters) m.value = valueText(m, now)
    const gauge = e.surface === 'desktop' ? 'svg' : barsFit(meters, e.props.bodyColumns ?? 0) ? 'text' : 'none'

    const barWidth = meters.length > SVG_WIDE_MAX_METERS ? SVG_NARROW_WIDTH : SVG_BAR.width
    const line = elements.Box({
      flexDirection: 'row',
      columnGap: METER_GAP,
      // In a narrow Desktop window a whole meter moves to the next row, rather than its text
      // breaking or running off the band
      ...(gauge === 'svg' && { flexWrap: 'wrap' }),
      children: meters.map((m) => meter(elements, gauge, m, barWidth)),
    })
    // Keep what the mods after this one draw in the band
    const rest = await next(e)
    if (!rest) return line
    return elements.Box({ flexDirection: 'column', children: [line, rest] })
  })
}

async function remember($, limits) {
  // Take the time first, so a refresh that runs meanwhile can't pair old limits with it
  const now = await $.clock.now()
  rateLimits = limits
  measuredAt = now
  await $.store.set(ownKey, { at: now, limits })
}

// Takes the newest reading any session saved, unless this session's own is newer still, and
// deletes the keys no session needs: ended sessions' older readings, and any reading too old
async function refresh($) {
  const { entries, newest } = await scan($)
  if (newest && newest.reading.at >= measuredAt) {
    rateLimits = newest.reading.limits
    measuredAt = newest.reading.at
  } else if (!newest && measuredAt < (await $.clock.now()) - STALE_MS) {
    // This session's own reading has gone stale too, as in one left idle for days
    rateLimits = []
    measuredAt = 0
  }
  await prune($, entries, newest?.key)
}

// Stops using this session's key: keeps its reading marked ended if it is the newest, so the
// others may delete it once a newer one exists, and removes it otherwise, since only the newest
// reading is ever shown
async function releaseKey($) {
  const { entries, newest } = await scan($)
  if (newest?.key === ownKey) await $.store.set(ownKey, { ...newest.reading, ended: true })
  else await $.store.delete(ownKey)
  await prune($, entries, newest?.key)
}

async function prune($, entries, newestKey) {
  const cutoff = (await $.clock.now()) - STALE_MS
  for (const { key, reading } of entries) {
    if (key === ownKey || key === newestKey) continue
    if (!isReading(reading) || reading.ended === true || reading.at < cutoff) await $.store.delete(key)
  }
}

// usage() at startup may answer this session's last reading, which can be older than the shared
// one in ways a merge can't tell apart (a window that went away, a spend limit that went down),
// so a shared reading always wins and the snapshot is saved only when there is none
async function publishSnapshot($, snapshot) {
  const { newest } = await scan($)
  if (newest) {
    rateLimits = newest.reading.limits
    measuredAt = newest.reading.at
    return
  }
  await remember($, snapshot)
}

// Every session's key and what it holds, and the newest reading among them. At an equal time the
// later key wins, so every session picks the same one.
async function scan($) {
  const entries = []
  let newest = null
  const cutoff = (await $.clock.now()) - STALE_MS
  for (const key of await $.store.keys()) {
    if (!key.startsWith(KEY_PREFIX)) continue
    const reading = await $.store.get(key)
    entries.push({ key, reading })
    if (!isReading(reading) || reading.at < cutoff) continue
    if (!newest || reading.at > newest.reading.at || (reading.at === newest.reading.at && key > newest.key)) {
      newest = { key, reading }
    }
  }
  return { entries, newest }
}

// Takes the per-model reading the sessions share, unless this session's own is newer, and drops
// one too old to say anything current
async function adoptScoped($) {
  const shared = await $.store.get(SCOPED_KEY)
  if (isReading(shared) && shared.at >= scoped.at) scoped = shared
  if (scoped.at < (await $.clock.now()) - STALE_MS) scoped = { at: 0, limits: [] }
}

// Asks the usage endpoint once the shared reading is due, and shares what it answers. A session
// with no first-party login, a refused request or an answer in another shape leaves the reading
// as it was.
async function pollScoped($) {
  const now = await $.clock.now()
  if (now - scoped.at < SCOPED_POLL_MS || now - scopedTriedAt < SCOPED_POLL_MS) return
  scopedTriedAt = now
  try {
    const auth = await $.session.authorize()
    if (!auth) return
    const res = await $.http.fetch(SCOPED_URL, { auth: auth.handle })
    const limits = res.ok ? scopedLimits(JSON.parse(res.text)) : null
    if (!limits) return
    scoped = { at: await $.clock.now(), limits }
    await $.store.set(SCOPED_KEY, scoped)
  } catch {
    // The next attempt is a poll away
  }
}

// The weekly limits the answer scopes to a model, as limits readLimit takes: an empty list for an
// account with none, null when the answer has no list of limits at all
function scopedLimits(usage) {
  if (!Array.isArray(usage?.limits)) return null
  const limits = []
  for (const limit of usage.limits) {
    const label = limit?.scope?.model?.display_name
    if (limit?.kind !== 'weekly_scoped' || typeof label !== 'string' || typeof limit.percent !== 'number') continue
    const resetsAtMs = typeof limit.resets_at === 'string' ? Date.parse(limit.resets_at) : NaN
    limits.push({
      kind: 'weekly_scoped',
      label,
      percentUsed: limit.percent,
      ...(Number.isFinite(resetsAtMs) && { resetsAt: new Date(resetsAtMs).toISOString() }),
    })
  }
  return limits
}

function isReading(value) {
  return value != null && typeof value.at === 'number' && Array.isArray(value.limits)
}

function readLimit(limit, now) {
  const window = WINDOWS[limit.kind]
  const label = limit.label ?? window?.label ?? limit.kind
  const resetsAtMs = limit.resetsAt == null ? null : Date.parse(limit.resetsAt)
  // A window that has reset since the last reading starts again from zero
  if (resetsAtMs != null && resetsAtMs <= now) {
    return { kind: limit.kind, label, used: 0, elapsed: window?.ms ? 0 : null, resetsAt: null }
  }
  const elapsed = window?.ms && resetsAtMs != null ? clamp(100 - ((resetsAtMs - now) / window.ms) * 100) : null
  return { kind: limit.kind, label, used: limit.percentUsed, elapsed, resetsAt: resetsAtMs, showsClock: window?.showsClock === true }
}

// Green, yellow or red by how far usage runs ahead of the time gone in its window
function statusOf(used, elapsed) {
  if (used >= RED_MIN_USED) return 'error'
  if (elapsed == null) return used >= 80 ? 'error' : used >= 50 ? 'warning' : 'success'
  const margin = elapsed - used
  if (margin < RED_BELOW_MARGIN) return 'error'
  if (margin < GREEN_MIN_MARGIN && used >= GREEN_MAX_USED) return 'warning'
  return 'success'
}

function valueText({ used, resetsAt, showsClock }, now) {
  let value = typeof used === 'number' ? Math.round(used) + '%' : '—'
  if (resetsAt != null) value += ' ' + untilReset(resetsAt - now)
  if (resetsAt != null && showsClock) value += ' (' + jstClock(resetsAt) + ')'
  return value
}

// Whether every meter fits on one line with its text bar; every character drawn is one cell wide
function barsFit(meters, columns) {
  const width = meters.reduce((sum, m) => sum + [...m.label].length + 1 + BAR_CELLS + 1 + [...m.value].length, 0)
  return width + METER_GAP * (meters.length - 1) <= columns - BAND_RESERVED_COLUMNS
}

function meter({ Box, Text, Svg }, gauge, { label, used, elapsed, value }, barWidth) {
  const known = typeof used === 'number'
  const status = known ? statusOf(used, elapsed) : null
  const style = known ? { color: status } : { dimColor: true }

  const children = [Text({ children: [label] })]
  if (gauge === 'svg') {
    children.push(
      Svg({
        source: svgBar(known ? used : 0, elapsed, status, barWidth),
        alt: label + ' ' + value + (elapsed == null ? '' : ', ' + Math.round(elapsed) + '% of the window gone'),
        width: barWidth,
        height: SVG_BAR.height,
      }),
    )
  } else if (gauge === 'text') {
    children.push(...textBar(Text, known ? used : 0, elapsed, status))
  }
  children.push(Text({ ...style, children: [value] }))
  return Box({
    key: 'meter-' + label,
    flexDirection: 'row',
    columnGap: 1,
    alignItems: 'center',
    ...(gauge === 'svg' && { flexShrink: 0 }),
    children,
  })
}

// The bar as runs of cells: used cells in the status color, the rest dim, and the time marker
function textBar(Text, used, elapsed, status) {
  const filled = Math.round((clamp(used) / 100) * BAR_CELLS)
  const marker = elapsed == null ? -1 : Math.min(BAR_CELLS - 1, Math.floor((elapsed / 100) * BAR_CELLS))
  const markerStyle = { color: MARKER_COLOR, bold: true }
  const usedStyle = status ? { color: status } : { dimColor: true }
  const restStyle = { dimColor: true }
  const cells = []
  for (let i = 0; i < BAR_CELLS; i++) {
    if (i === marker) cells.push({ char: '┃', style: markerStyle })
    else if (i < filled) cells.push({ char: '█', style: usedStyle })
    else cells.push({ char: '░', style: restStyle })
  }
  const runs = []
  for (const cell of cells) {
    const last = runs.at(-1)
    if (last && last.style === cell.style) last.text += cell.char
    else runs.push({ text: cell.char, style: cell.style })
  }
  // One Text per run, nested in a Text so the runs stay on one line with no gaps
  return [Text({ children: runs.map((run) => Text({ ...run.style, children: [run.text] })) })]
}

function svgBar(used, elapsed, status, width) {
  const { height } = SVG_BAR
  const r = height / 2
  const fill = Math.round((clamp(used) / 100) * width)
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<clipPath id="c"><rect width="${width}" height="${height}" rx="${r}"/></clipPath>`,
    `<g clip-path="url(#c)">`,
    `<rect width="${width}" height="${height}" fill="${SVG_COLORS.track}"/>`,
  ]
  if (fill > 0) parts.push(`<rect width="${fill}" height="${height}" fill="${SVG_COLORS[status ?? 'success']}"/>`)
  parts.push('</g>')
  if (elapsed != null) {
    const x = Math.min(width - 2, Math.max(0, Math.round((elapsed / 100) * width) - 1))
    parts.push(`<rect x="${x}" width="2" height="${height}" fill="${SVG_COLORS.marker}"/>`)
  }
  parts.push('</svg>')
  return parts.join('')
}

function clamp(percent) {
  return Math.min(Math.max(percent, 0), 100)
}

// The time of day as HH:MM, 24-hour, in JST
function jstClock(ms) {
  const jst = new Date(ms + JST_OFFSET_MS)
  return String(jst.getUTCHours()).padStart(2, '0') + ':' + String(jst.getUTCMinutes()).padStart(2, '0')
}

function untilReset(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return days + 'd' + hours + 'h'
  if (hours > 0) return hours + 'h' + (minutes % 60) + 'm'
  return (minutes % 60) + 'm'
}

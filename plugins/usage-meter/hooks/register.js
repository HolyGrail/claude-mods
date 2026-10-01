// Shows context, 5-hour limit and weekly limit usage in the band above the prompt.

// The latest figures this session has, from $.session.usage() or session.measure
let context = null
let rateLimits = []
// When rateLimits was last measured, in $.clock.now() milliseconds
let measuredAt = 0
// The timer that refreshes the band, kept so a later session.start can stop it
let ticker = null

// Rate limits are per account, so share the newest reading with the other sessions
const STORE_KEY = 'rateLimits'
// How often to pick up other sessions' readings and refresh the countdowns and time markers
const TICK_MS = 60_000

const HOUR_MS = 3_600_000
const WINDOWS = {
  // showsClock adds the reset time of day, in JST
  five_hour: { label: '5h', ms: 5 * HOUR_MS, showsClock: true },
  seven_day: { label: '7d', ms: 7 * 24 * HOUR_MS },
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
// Below this width the terminal leaves the bars out
const BARS_MIN_COLUMNS = 80
const SVG_BAR = { width: 96, height: 10 }
const SVG_COLORS = { success: '#4caf50', warning: '#e0a526', error: '#e5534b', track: 'rgba(128,128,128,0.3)', marker: '#5b9bff' }
// The terminal draws the time marker in this color
const MARKER_COLOR = 'cyan'

export function register(on) {
  // Fires again on an enable or a worker respawn, which may keep this module's variables
  on('session.start', async ($, e, next) => {
    ticker?.cancel()
    rateLimits = []
    measuredAt = 0
    const usage = await $.session.usage()
    context = usage.context
    if (usage.rateLimits.length > 0) {
      await remember($, usage.rateLimits)
    } else {
      await adoptShared($)
    }
    ticker = $.clock.every(TICK_MS, async () => {
      await adoptShared($)
      $.ui.invalidate('ui.render')
    })
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Fires after each turn, and when a rate-limit window moves a whole point
  on('session.measure', async ($, e, next) => {
    context = e.context
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      await remember($, e.rateLimits)
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const elements = $.ui.resolve(e)
    const now = await $.clock.now()
    const gauge = e.surface === 'desktop' ? 'svg' : (e.props.bodyColumns ?? 0) >= BARS_MIN_COLUMNS ? 'text' : 'none'

    const meters = [{ label: 'ctx', used: context?.percent, elapsed: null, resetsAt: null }]
    for (const limit of rateLimits) {
      meters.push(readLimit(limit, now))
    }

    const line = elements.Box({
      flexDirection: 'row',
      columnGap: 3,
      children: meters.map((m) => meter(elements, gauge, m, now)),
    })
    // Keep what the mods after this one draw in the band
    const rest = await next(e)
    if (!rest) return line
    return elements.Box({ flexDirection: 'column', children: [line, rest] })
  })
}

async function remember($, limits) {
  rateLimits = limits
  measuredAt = await $.clock.now()
  await $.store.set(STORE_KEY, { at: measuredAt, limits })
}

// Takes another session's reading when it is newer than this session's
async function adoptShared($) {
  const shared = await $.store.get(STORE_KEY)
  if (shared && shared.at > measuredAt && Array.isArray(shared.limits)) {
    rateLimits = shared.limits
    measuredAt = shared.at
  }
}

function readLimit(limit, now) {
  const window = WINDOWS[limit.kind]
  const label = window?.label ?? limit.kind
  const resetsAtMs = limit.resetsAt == null ? null : Date.parse(limit.resetsAt)
  // A window that has reset since the last reading starts again from zero
  if (resetsAtMs != null && resetsAtMs <= now) {
    return { label, used: 0, elapsed: window?.ms ? 0 : null, resetsAt: null }
  }
  const elapsed = window?.ms && resetsAtMs != null ? clamp(100 - ((resetsAtMs - now) / window.ms) * 100) : null
  return { label, used: limit.percentUsed, elapsed, resetsAt: resetsAtMs, showsClock: window?.showsClock === true }
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

function meter({ Box, Text, Svg }, gauge, { label, used, elapsed, resetsAt, showsClock }, now) {
  const known = typeof used === 'number'
  const status = known ? statusOf(used, elapsed) : null
  const style = known ? { color: status } : { dimColor: true }
  let value = known ? Math.round(used) + '%' : '—'
  if (resetsAt != null) value += ' ' + untilReset(resetsAt - now)
  if (resetsAt != null && showsClock) value += ' (' + jstClock(resetsAt) + ')'

  const children = [Text({ children: [label] })]
  if (gauge === 'svg') {
    children.push(
      Svg({
        source: svgBar(known ? used : 0, elapsed, status),
        alt: label + ' ' + value + (elapsed == null ? '' : ', ' + Math.round(elapsed) + '% of the window gone'),
        width: SVG_BAR.width,
        height: SVG_BAR.height,
      }),
    )
  } else if (gauge === 'text') {
    children.push(...textBar(Text, known ? used : 0, elapsed, status))
  }
  children.push(Text({ ...style, children: [value] }))
  return Box({ key: 'meter-' + label, flexDirection: 'row', columnGap: 1, alignItems: 'center', children })
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

function svgBar(used, elapsed, status) {
  const { width, height } = SVG_BAR
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

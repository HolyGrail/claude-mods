// Draws a gauge in the band above the prompt for the main conversation's prompt cache: how long
// it stays warm, its hit ratio and misses, and once it has gone cold, how many tokens the next
// message writes to the cache again.

// The last main-thread request that came back with usage: { seq, at, ttl, model, tokens, prefix, cached, expired }
// - seq: which main request it was, counted across the module's life, so a fork can tell whether
//   the entry it read is still the newest
// - at: when it was sent, in $.clock.now() milliseconds. Each request that reads the cache resets
//   its TTL, so the TTL runs from here; the response may end minutes later.
// - ttl: the TTL resolved as it came back, { ttl, estimated }, since Claude Code picks one per
//   request; null when unknown (a resumed conversation), which takes the TTL as it stands now
// - model: the model that answered it, null when unknown (a resumed conversation); each model has
//   a cache of its own
// - tokens: what the next request re-sends, input + cache read + cache write + output, as the
//   engine counts it for a model switch
// - prefix: what the cache held after it, cache read + cache write; the next request reads about
//   this much when the cache is still there
// - cached: whether the response reported any cache tokens at all
// - expired: the engine said, on resume, that the cache had likely gone cold
let last = null
// The model the main loop runs now, as the last step or model switch named it
let model = null
// This conversation's main requests: input tokens in all and from the cache, and the requests
// that wrote back what the cache had held, with the likely cause of the last one
let stats = emptyStats()
// The TTL the engine stated at the last model switch: { ttl, overLimit }, kept only while the
// plan usage stays on the side of the limit it was on then
let engineTtl = null
// The TTL as last resolved, { ttl, estimated }, for a request whose own is unknown, and whether
// caching is switched off
let ttl = defaultTtl()
let disabled = false
// The rate-limit windows, for the TTL estimate: past a window's limit, usage credits pay
let rateLimits = []
// After /compact, the next request rebuilds the conversation layer: not a miss
let compacted = false
// The subagents whose first request has been seen: only a fork's first reads the main
// conversation's entry, hit or miss
let agentsSeen = new Set()
// Numbers the main requests (`last.seq`)
let mainRequests = 0
// The timer that redraws the gauge when its text next changes
let timer = null
// Counts refreshes and resets, so only the latest refresh redraws: one begun before a later one,
// or before /clear and the rest, leaves the gauge alone
let refreshes = 0

const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
// The session.end reasons after which this module stops; /clear, /resume and logout leave it
// running
const FINAL_REASONS = ['prompt_input_exit', 'other']
// The windows a subscription's plan usage is measured in; past either, Claude Code draws on usage
// credits and drops the main conversation to five minutes
const PLAN_WINDOWS = ['five_hour', 'seven_day']
// A request that read less than this share of what the cache held before it is a miss
const MISS_BELOW_SHARE = 0.5
// Under this share of the TTL left, the gauge turns yellow
const WARN_BELOW_SHARE = 0.2

const BAR_CELLS = 10
// The band's last column, which the terminal may draw over
const BAND_RESERVED_COLUMNS = 2
const SVG_BAR = { width: 96, height: 10 }
const SVG_COLORS = { success: '#4caf50', warning: '#e0a526', error: '#e5534b', track: 'rgba(128,128,128,0.3)' }

export function register(on) {
  // Fires again on an enable or a worker respawn, which may keep this module's variables
  on('session.start', async ($, e, next) => {
    reset()
    engineTtl = null
    ttl = defaultTtl()
    disabled = false
    rateLimits = (await $.session.usage()).rateLimits
    void refresh($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (!FINAL_REASONS.includes(e.reason)) return next(e)
    refreshes += 1
    timer?.cancel()
    timer = null
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      rateLimits = e.rateLimits
      void refresh($)
    }
    return next(e)
  })

  // The main loop's requests (no agentId) move the gauge. Subagents and workflows keep caches of
  // their own, with their own TTL; a fork inherits the main conversation whole, so its first
  // request reads the main entry and resets its timer.
  on('turn.step', async function* ($, e, next) {
    const sentAt = await $.clock.now()
    // The main entry as this request went out, which a fork's request read if it read any
    const parent = last
    const response = yield* next(e)
    const usage = response?.usage
    if (!usage) return response
    // A later mod may have sent the request to another model than the step named
    const answeredBy = usage.model || e.model
    if (e.agentId) {
      // Forks that overlap may answer out of order: the newest read stands, and a main request
      // recorded since holds an entry the fork did not read
      const read = await readsMainEntry($, e.agentId, parent, answeredBy, usage).catch(() => false)
      if (read && last?.seq === parent.seq && sentAt > last.at) {
        last = { ...last, at: sentAt }
        void refresh($)
      }
      return response
    }
    // Unresolved, the request takes the TTL as it stands when drawn
    const resolved = await resolveTtl($).catch(() => null)
    const read = usage.cache_read_input_tokens
    const written = usage.cache_creation_input_tokens
    count(answeredBy, sentAt, usage)
    last = {
      seq: ++mainRequests,
      at: sentAt,
      ttl: resolved,
      model: answeredBy,
      tokens: usage.input_tokens + read + written + usage.output_tokens,
      prefix: read + written,
      cached: read + written > 0,
      expired: false,
    }
    model = answeredBy
    compacted = false
    void refresh($)
    return response
  })

  // The engine states the TTL it uses here, which no other event carries
  on('classic.PostModelSwitch', async ($, e, next) => {
    model = e.to_model
    engineTtl = { ttl: e.cache_ttl, overLimit: overLimit() }
    if (last && e.context_tokens > 0) last = { ...last, tokens: e.context_tokens }
    void refresh($)
    return next(e)
  })

  // /clear starts a conversation with nothing cached for it yet. /compact replaces the history,
  // so the next request writes the summary's cache. A resumed or forked conversation carries how
  // long ago it last had a response, which dates its cache.
  on('classic.SessionStart', { source: ['clear', 'compact', 'resume', 'fork'] }, async ($, e, next) => {
    if (e.source === 'compact') {
      compacted = true
    } else {
      reset()
      if (typeof e.seconds_since_last_response === 'number' && typeof e.context_tokens === 'number') {
        last = {
          seq: ++mainRequests,
          at: (await $.clock.now()) - e.seconds_since_last_response * 1000,
          ttl: null,
          model: null,
          tokens: e.context_tokens,
          prefix: e.context_tokens,
          cached: true,
          expired: e.prompt_cache_likely_expired === true,
        }
      }
    }
    void refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const view = viewAt(await $.clock.now())
    if (!view) return rest
    const elements = $.ui.resolve(e)
    // Only a warm cache has time left to draw as a bar
    let gauge = 'none'
    if (view.kind === 'warm') gauge = e.surface === 'desktop' ? 'svg' : fits(view, e.props.bodyColumns ?? 0) ? 'text' : 'none'
    const line = gaugeLine(elements, gauge, view)
    if (!rest) return line
    return elements.Box({ flexDirection: 'column', children: [line, rest] })
  })
}

function defaultTtl() {
  return { ttl: '1h', estimated: true }
}

function emptyStats() {
  return { input: 0, read: 0, misses: 0, lastMissCause: null }
}

function reset() {
  refreshes += 1
  timer?.cancel()
  timer = null
  last = null
  model = null
  stats = emptyStats()
  compacted = false
  agentsSeen = new Set()
}

// Whether a subagent's request was a fork's first and read `parent`, the main conversation's
// cached prefix as it went out: the same model, and at least as much read as a request that hit it
// would. Only an agent's first request counts, hit or miss: its later ones read its own entry.
async function readsMainEntry($, agentId, parent, answeredBy, usage) {
  if (agentsSeen.has(agentId)) return false
  agentsSeen.add(agentId)
  if (!parent?.cached) return false
  if (parent.model && parent.model !== answeredBy) return false
  if (usage.cache_read_input_tokens < parent.prefix * MISS_BELOW_SHARE) return false
  const agent = (await $.agent.list()).find((a) => a.id === agentId)
  return agent?.type === 'fork'
}

// Adds a main request to the conversation's figures. A request that reads well under what the
// cache held after the one before re-processed what had been cached: a miss, unless /compact
// rewrote the conversation, which rebuilds on purpose.
function count(stepModel, sentAt, usage) {
  const read = usage.cache_read_input_tokens
  stats.input += usage.input_tokens + read + usage.cache_creation_input_tokens
  stats.read += read
  if (!last || !last.cached || compacted || read >= last.prefix * MISS_BELOW_SHARE) return
  stats.misses += 1
  if (last.model && last.model !== stepModel) stats.lastMissCause = 'model switch'
  else if (last.expired || sentAt - last.at > TTL_MS[(last.ttl ?? ttl).ttl]) stats.lastMissCause = 'expired'
  else stats.lastMissCause = null
}

// Takes up the TTL and the switches as they stand, redraws, and sets a timer for the moment the
// gauge's text next changes. Never awaited by a hook, so it keeps its failures to itself: the next
// event or timer tries again.
async function refresh($) {
  const started = ++refreshes
  try {
    const resolved = await resolveTtl($)
    const off = (await $.env.get('DISABLE_PROMPT_CACHING')) === '1'
    const now = await $.clock.now()
    if (started !== refreshes) return
    ttl = resolved
    disabled = off
    redraw($, now)
  } catch {
    // A module being unloaded is refused its calls
  }
}

function redraw($, now) {
  timer?.cancel()
  timer = null
  $.ui.invalidate('ui.render')
  const view = viewAt(now)
  if (view?.kind !== 'warm') return
  // Minutes count down by the minute, the last one by the second, and the last tick lands on the
  // expiry itself
  const step = view.remaining > 60_000 ? 60_000 : 1_000
  timer = $.clock.after(view.remaining % step || step, () => {
    void $.clock.now().then(
      (at) => redraw($, at),
      () => {},
    )
  })
}

// What the gauge shows at `now`, or null before there is anything to show
function viewAt(now) {
  if (disabled) return { kind: 'off', reason: 'DISABLE_PROMPT_CACHING' }
  if (compacted) return { kind: 'rebuilding' }
  if (!last) return null
  if (!last.cached) return { kind: 'off', reason: 'no cache tokens reported' }
  if (last.model && model && last.model !== model) return { kind: 'cold', reason: 'model switch', tokens: last.tokens }
  const own = last.ttl ?? ttl
  const ttlMs = TTL_MS[own.ttl]
  const remaining = last.at + ttlMs - now
  if (last.expired || remaining <= 0) return { kind: 'cold', reason: null, tokens: last.tokens }
  return {
    kind: 'warm',
    remaining,
    share: remaining / ttlMs,
    ttl: (own.estimated ? '~' : '') + own.ttl,
    hit: stats.input > 0 ? Math.round((stats.read / stats.input) * 100) : null,
    misses: stats.misses,
    lastMissCause: stats.lastMissCause,
  }
}

// The gauge's runs of text with their styles: the bar goes after `head`, `value` in the status
// color after it, and `tail` in the default color last
function parts(view) {
  if (view.kind === 'warm') {
    const status = view.share < WARN_BELOW_SHARE ? 'warning' : 'success'
    const after = []
    if (view.hit != null) after.push('hit ' + view.hit + '%')
    after.push('misses ' + view.misses + (view.misses > 0 && view.lastMissCause ? ' (' + view.lastMissCause + ')' : ''))
    return {
      status,
      head: { text: 'cache ● ' + view.ttl, style: { color: status } },
      value: { text: timeLeft(view.remaining) + ' left', style: { color: status } },
      tail: ' · ' + after.join(' · '),
    }
  }
  if (view.kind === 'cold') {
    return {
      status: 'error',
      head: { text: 'cache ○ cold', style: { color: 'error' } },
      tail: ' · ' + (view.reason ? view.reason + ' · ' : '') + 'next message re-caches ' + tokenCount(view.tokens) + ' tokens',
    }
  }
  if (view.kind === 'rebuilding') {
    return {
      status: 'warning',
      head: { text: 'cache ○ rebuilding', style: { color: 'warning' } },
      tail: ' · next message caches the /compact summary',
    }
  }
  return { status: null, head: { text: 'cache ○ off', style: { dimColor: true } }, tail: ' · ' + view.reason }
}

// Whether the line fits with its text bar; every character drawn is one cell wide
function fits(view, columns) {
  const { head, value, tail } = parts(view)
  const width = [...head.text].length + 1 + BAR_CELLS + 1 + (value ? [...value.text].length : 0) + [...tail].length
  return width <= columns - BAND_RESERVED_COLUMNS
}

function gaugeLine({ Box, Text, Svg }, gauge, view) {
  const { status, head, value, tail } = parts(view)
  const share = view.share ?? 0
  const headText = Text({ ...head.style, children: [head.text] })
  // Without a value there is no bar either: the head and what follows stay one run
  if (!value) return Box({ key: 'cache-meter', flexDirection: 'row', children: [Text({ children: [headText, tail] })] })
  const children = [headText]
  if (gauge === 'svg') {
    children.push(
      Svg({
        source: svgBar(share, status),
        alt: head.text + ' ' + value.text + tail,
        width: SVG_BAR.width,
        height: SVG_BAR.height,
      }),
    )
  } else if (gauge === 'text') {
    children.push(textBar(Text, share, status))
  }
  // The value and what follows it stay one run, so no gap opens before the separator
  children.push(Text({ children: [Text({ ...value.style, children: [value.text] }), tail] }))
  return Box({
    key: 'cache-meter',
    flexDirection: 'row',
    columnGap: 1,
    alignItems: 'center',
    ...(gauge === 'svg' && { flexWrap: 'wrap' }),
    children,
  })
}

// The bar as two runs: the share of the TTL left in the status color, the rest dim
function textBar(Text, share, status) {
  const filled = Math.round(Math.min(Math.max(share, 0), 1) * BAR_CELLS)
  const runs = []
  if (filled > 0) runs.push(Text({ color: status ?? 'success', children: ['█'.repeat(filled)] }))
  if (filled < BAR_CELLS) runs.push(Text({ dimColor: true, children: ['░'.repeat(BAR_CELLS - filled)] }))
  return Text({ children: runs })
}

function svgBar(share, status) {
  const { width, height } = SVG_BAR
  const r = height / 2
  const fill = Math.round(Math.min(Math.max(share, 0), 1) * width)
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<clipPath id="c"><rect width="${width}" height="${height}" rx="${r}"/></clipPath>`,
    `<g clip-path="url(#c)">`,
    `<rect width="${width}" height="${height}" fill="${SVG_COLORS.track}"/>`,
  ]
  if (fill > 0) parts.push(`<rect width="${fill}" height="${height}" fill="${SVG_COLORS[status ?? 'success']}"/>`)
  parts.push('</g>', '</svg>')
  return parts.join('')
}

// The main conversation's TTL, in the order Claude Code takes it: the engine's own word at a model
// switch, then FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, the promptCacheTtl setting
// and ENABLE_PROMPT_CACHING_1H. Without any of them, the default is estimated: one hour on a
// subscription within its plan usage, five minutes past it and on an API key or cloud provider.
async function resolveTtl($) {
  if (engineTtl && engineTtl.overLimit === overLimit()) return { ttl: engineTtl.ttl, estimated: false }
  if ((await $.env.get('FORCE_PROMPT_CACHING_5M')) === '1') return { ttl: '5m', estimated: false }
  const fromEnv = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
  if (isTtl(fromEnv)) return { ttl: fromEnv, estimated: false }
  const fromSettings = (await $.settings.read()).promptCacheTtl
  if (isTtl(fromSettings)) return { ttl: fromSettings, estimated: false }
  if ((await $.env.get('ENABLE_PROMPT_CACHING_1H')) === '1') return { ttl: '1h', estimated: false }
  const auth = await $.session.authorize()
  return { ttl: auth?.kind === 'bearer' && !overLimit() ? '1h' : '5m', estimated: true }
}

// Only the two values Claude Code takes; it ignores any other
function isTtl(value) {
  return value === '5m' || value === '1h'
}

function overLimit() {
  return rateLimits.some((limit) => PLAN_WINDOWS.includes(limit.kind) && limit.percentUsed >= 100)
}

function timeLeft(ms) {
  if (ms > 60_000) return Math.ceil(ms / 60_000) + 'm'
  return Math.ceil(ms / 1_000) + 's'
}

function tokenCount(tokens) {
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + 'M'
  if (tokens >= 1_000) return Math.round(tokens / 1_000) + 'k'
  return String(tokens)
}

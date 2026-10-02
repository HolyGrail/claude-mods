import type { SessionContextUsage, SessionRateLimit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// 2026-10-01T12:00:00Z, 21:00 in JST
const NOW = Date.UTC(2026, 9, 1, 12)

const BAND = {
  plugin: 'usage-meter',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns: 120, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

// The stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

function fiveHour(percentUsed: number, remainingMs: number): SessionRateLimit {
  return { kind: 'five_hour', percentUsed, resetsAt: new Date(NOW + remainingMs).toISOString() }
}

const LIMITS: SessionRateLimit[] = [
  fiveHour(62, 2 * HOUR + 13 * MINUTE),
  { kind: 'seven_day', percentUsed: 5, resetsAt: new Date(NOW + 4 * 24 * HOUR + 18 * HOUR).toISOString() },
]

const CONTEXT: SessionContextUsage = { tokens: 39_205, window: 200_000, percent: 20 }

// This session's key in the store, and another session's
const OWN = 'reading:this'
const OTHER = 'reading:other'

function stubStore(on: On, saved: Map<string, unknown>, onList = () => {}, sessionId = () => 'this') {
  on('session.id', () => ({ value: sessionId() }))
  on('store.keys', () => {
    onList()
    return { value: [...saved.keys()] }
  })
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    saved.delete(e.key)
    return { value: undefined }
  })
}

function stubSession(on: On, saved: Map<string, unknown>, rateLimits = LIMITS, context = CONTEXT) {
  on('session.usage', () => ({ value: { startedAt: NOW, context, rateLimits } }))
  on('session.start', () => ({ cwd: '/work' }))
  stubStore(on, saved)
  // What the mods after this one draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))
}

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const END = { reason: 'other', sessionId: 'this', resume: { id: '' } } as const

test('colors a limit by how far usage runs ahead of the time gone', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map(), [])
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start(START)

  // 2.5 hours left of 5, so half the window is gone
  const half = 2.5 * HOUR
  for (const [used, color] of [[30, 'success'], [50, 'warning'], [80, 'error']] as const) {
    await $.session.measure({ context: CONTEXT, rateLimits: [fiveHour(used, half)], changed: ['rateLimits'] })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: used + '% 2h30m (23:30)' })).toMatchObject({ props: { color } })
    await ui.unmount()
  }
})

test('the 5-hour limit shows its reset time in JST past midnight', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map(), [fiveHour(40, 3 * HOUR + 5 * MINUTE)])
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '40% 3h5m (00:05)' })).toBeDefined()
})

test('a fresh window with little usage is green', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map(), [fiveHour(3, 5 * HOUR - 5 * MINUTE)])
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^3% / })).toMatchObject({ props: { color: 'success' } })
})

test('the terminal bar fills to the usage and marks the time gone', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map(), [fiveHour(30, 2.5 * HOUR)])
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // 30% of 10 cells used, and the marker in the sixth cell for half the window
  expect(await ui.find({ type: 'Text', text: /^███░░┃░░░░$/ })).toMatchObject({
    children: [
      { props: { color: 'success' }, children: ['███'] },
      { props: { dimColor: true }, children: ['░░'] },
      { props: { color: 'cyan' }, children: ['┃'] },
      { props: { dimColor: true }, children: ['░░░░'] },
    ],
  })
})

test('the Desktop app draws each bar as an SVG with the time marker', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map(), [fiveHour(30, 2.5 * HOUR)])
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const meter = await ui.find({ key: 'meter-5h' })
  // The meter's children: its label, its bar and its value
  const [, svg] = (meter?.children ?? []) as { type: string; props: { source: string } }[]
  expect(svg).toMatchObject({ type: 'Svg', props: { width: 96, height: 10 } })
  const source = svg?.props.source ?? ''
  // 30% of 96 pixels filled in green, and the marker at the middle
  expect(source).toContain('<rect width="29" height="10" fill="#4caf50"/>')
  expect(source).toContain('<rect x="47" width="2" height="10" fill="#5b9bff"/>')
  expect(await ui.find({ type: 'Text', text: /^30% / })).toBeDefined()
})

test('draws context, both limits and the other mods on each surface', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '20%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '62% 2h13m (23:13)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5% 4d18h$/ })).toMatchObject({ props: { color: 'success' } })
    expect(await ui.find({ type: 'Text', text: 'drawn by another mod' })).toBeDefined()
    // Desktop leaves a row between the meters and the other mods; the terminal keeps its rows
    expect(await ui.find({ type: 'Box' })).toMatchObject({ props: { rowGap: surface === 'desktop' ? 1 : 0 } })
    await ui.unmount()
  }
})

test('leaves the bars out in a narrow terminal', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 50 } })
  expect(await ui.find({ type: 'Text', text: '20%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /░/ })).toBeUndefined()
})

test('session.measure updates the figures and shares the limits', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start(START)

  const rateLimits = [{ ...LIMITS[0]!, percentUsed: 91 }, LIMITS[1]!]
  await $.session.measure({
    context: { tokens: 150_000, window: 200_000, percent: 75 },
    rateLimits,
    changed: ['context', 'rateLimits'],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '75%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^91% / })).toMatchObject({ props: { color: 'error' } })
  expect(saved.get(OWN)).toEqual({ at: NOW, limits: rateLimits })
})

test('picks up a newer reading another session shared', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  // This session has no reading of its own yet
  stubSession(on, saved, [])
  await $.session.start(START)

  saved.set(OTHER, { at: NOW + 1, limits: LIMITS })
  await clock.advance(MINUTE)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^62% / })).toBeDefined()
})

test('a window past its reset time shows 0%', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  await $.session.start(START)

  await clock.advance(3 * HOUR)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '0%' })).toMatchObject({ props: { color: 'success' } })
})

test('shows a dash before the first reading', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map(), [], { window: 200_000 })
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '—' })).toMatchObject({ props: { dimColor: true } })
})

test('a later session.start keeps one timer and shows the newest shared reading', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  let starts = 0
  let lists = 0
  // The first start reports limits, the later ones report none
  on('session.usage', () => ({ value: { startedAt: NOW, context: CONTEXT, rateLimits: starts++ === 0 ? LIMITS : [] } }))
  on('session.start', () => ({ cwd: '/work' }))
  stubStore(on, saved, () => {
    lists += 1
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))

  await $.session.start(START)
  // Limits are per account, so the reading the first start saved is still the newest one
  await $.session.start(START)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^62% / })).toBeDefined()
  await ui.unmount()

  // With nothing saved, the earlier start's limits are not kept in the module
  saved.clear()
  await $.session.start(START)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^62% / })).toBeUndefined()

  // Only the last start's timer lists the store
  lists = 0
  await clock.advance(MINUTE)
  expect(lists).toBe(1)
})
const SPEND: SessionRateLimit = { kind: 'spend_limit', percentUsed: 40 }

test('drops the bars when every meter would not fit on the line', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map(), [...LIMITS, SPEND])
  await $.session.start(START)

  // Four meters with bars take 96 columns, two more than the band leaves free at 96
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 96 } })
  expect(await ui.find({ type: 'Text', text: /░/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '40%' })).toBeDefined()
  await ui.unmount()

  ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 98 } })
  expect(await ui.find({ type: 'Text', text: /░/ })).toBeDefined()
})

test('three meters keep their bars at 80 columns', async ($, on) => {
  mock.clock(on, { now: NOW })
  stubSession(on, new Map())
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 80 } })
  expect(await ui.find({ type: 'Text', text: /░/ })).toBeDefined()
})

test('a startup snapshot older than the shared reading does not overwrite it', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  // Another session measured more of the same 5-hour window since this one last did
  const shared = [fiveHour(70, 2 * HOUR + 13 * MINUTE), LIMITS[1]!]
  saved.set(OTHER, { at: NOW - MINUTE, limits: shared })
  stubSession(on, saved)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^70% / })).toBeDefined()
  // The snapshot is not saved over the shared reading
  expect(saved.get(OWN)).toBeUndefined()
  expect(saved.get(OTHER)).toEqual({ at: NOW - MINUTE, limits: shared })
})

test('a measurement that reports no windows clears the limits', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start(START)

  await $.session.measure({ context: CONTEXT, rateLimits: [], changed: ['rateLimits'] })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^62% / })).toBeUndefined()
  expect(saved.get(OWN)).toEqual({ at: NOW, limits: [] })
})

test('an empty shared reading wins over a startup snapshot', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  // Another session measured that the account's windows went away
  saved.set(OTHER, { at: NOW - MINUTE, limits: [] })
  stubSession(on, saved)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^62% / })).toBeUndefined()
  expect(saved.get(OWN)).toBeUndefined()
  expect(saved.get(OTHER)).toEqual({ at: NOW - MINUTE, limits: [] })
})

test('a shared reading wins over a startup snapshot that has more windows', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  // Another session measured that only the 5-hour window applies now
  const shared = [LIMITS[0]!]
  saved.set(OTHER, { at: NOW - MINUTE, limits: shared })
  stubSession(on, saved)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^62% / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4d18h/ })).toBeUndefined()
  expect(saved.get(OWN)).toBeUndefined()
  expect(saved.get(OTHER)).toEqual({ at: NOW - MINUTE, limits: shared })
})

test('a shared spend limit that went down wins over a higher startup snapshot', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  saved.set(OTHER, { at: NOW - MINUTE, limits: [{ kind: 'spend_limit', percentUsed: 5 }] })
  stubSession(on, saved, [{ kind: 'spend_limit', percentUsed: 90 }])
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '5%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '90%' })).toBeUndefined()
})

test('readings at the same time resolve to the later key in every session', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved, [])
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start(START)

  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['rateLimits'] })
  // Another session saved in the same millisecond, under a key that sorts after this one's
  saved.set('reading:zz', { at: NOW, limits: [fiveHour(64, 2 * HOUR + 13 * MINUTE), LIMITS[1]!] })
  await clock.advance(MINUTE)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^64% / })).toBeDefined()
})

test('an older reading another session saved leaves both keys and the display alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved, [])
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start(START)

  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['rateLimits'] })
  // A delayed write of an older measurement lands in the other session's own key
  const older = { at: NOW - MINUTE, limits: [fiveHour(55, 2 * HOUR + 13 * MINUTE), LIMITS[1]!] }
  saved.set(OTHER, older)
  await clock.advance(MINUTE)

  expect(saved.get(OWN)).toEqual({ at: NOW, limits: LIMITS })
  expect(saved.get(OTHER)).toEqual(older)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^62% / })).toBeDefined()
})

test('readings older than the longest window are deleted, but not this session own', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved)
  await $.session.start(START)

  saved.set(OTHER, { at: NOW - 9 * 24 * HOUR, limits: LIMITS })
  await clock.advance(MINUTE)

  expect(saved.has(OTHER)).toBe(false)
  expect(saved.has(OWN)).toBe(true)
})

test('a session that ends removes its key unless it holds the newest reading', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved, [])
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.end', () => ({ sessionId: 'this' }))
  await $.session.start(START)
  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['rateLimits'] })

  // Another session saved a newer reading, so this session's key goes, and the other's stays
  saved.set(OTHER, { at: NOW + MINUTE, limits: LIMITS })
  await $.session.end(END)
  expect(saved.has(OWN)).toBe(false)
  expect(saved.has(OTHER)).toBe(true)
})

test('a session that ends with the newest reading keeps it, marked ended', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved, [])
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.end', () => ({ sessionId: 'this' }))
  await $.session.start(START)
  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['rateLimits'] })

  saved.set(OTHER, { at: NOW - MINUTE, limits: LIMITS })
  saved.set('reading:ended-old', { at: NOW - MINUTE, limits: LIMITS, ended: true })
  await $.session.end(END)
  expect(saved.get(OWN)).toEqual({ at: NOW, limits: LIMITS, ended: true })
  // A live session's key stays, and an ended session's older one goes
  expect(saved.has(OTHER)).toBe(true)
  expect(saved.has('reading:ended-old')).toBe(false)
})

test('/clear, /resume and logout leave the key and the refresh timer running', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved)
  on('session.end', () => ({ sessionId: 'this' }))
  await $.session.start(START)

  for (const reason of ['clear', 'resume', 'logout'] as const) {
    await $.session.end({ ...END, reason })
  }
  expect(saved.get(OWN)).toEqual({ at: NOW, limits: LIMITS })
  saved.set(OTHER, { at: NOW + 1, limits: [fiveHour(70, 2 * HOUR), LIMITS[1]!] })
  await clock.advance(MINUTE)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^70% / })).toBeDefined()
})
test('an ended session older reading is deleted, but an ended newest one stays', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved, [])
  await $.session.start(START)

  const newest = { at: NOW, limits: LIMITS, ended: true }
  saved.set('reading:ended-old', { at: NOW - HOUR, limits: LIMITS, ended: true })
  saved.set('reading:ended-new', newest)
  saved.set('reading:live-old', { at: NOW - HOUR, limits: LIMITS })
  await clock.advance(MINUTE)

  expect(saved.has('reading:ended-old')).toBe(false)
  expect(saved.get('reading:ended-new')).toEqual(newest)
  // A live session may still write its key, so only its own end removes it
  expect(saved.has('reading:live-old')).toBe(true)
})

test('a session clears ended sessions older keys as it starts', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  saved.set('reading:ended-old', { at: NOW - HOUR, limits: LIMITS, ended: true })
  saved.set(OTHER, { at: NOW - MINUTE, limits: LIMITS })
  stubSession(on, saved)
  await $.session.start(START)

  expect(saved.has('reading:ended-old')).toBe(false)
  expect(saved.has(OTHER)).toBe(true)
})

test('a reading older than the longest window is never shown, even as the only one', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  saved.set(OTHER, { at: NOW - 9 * 24 * HOUR, limits: [{ kind: 'spend_limit', percentUsed: 90 }] })
  stubSession(on, saved, [{ kind: 'spend_limit', percentUsed: 5 }])
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '5%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '90%' })).toBeUndefined()
  // The startup snapshot is saved, and the stale key is deleted
  expect(saved.get(OWN)).toEqual({ at: NOW, limits: [{ kind: 'spend_limit', percentUsed: 5 }] })
  expect(saved.has(OTHER)).toBe(false)
})

test('/clear shows the emptied context before the next turn', async ($, on) => {
  mock.clock(on, { now: NOW })
  let cleared = false
  on('session.usage', () => ({
    value: { startedAt: NOW, context: cleared ? { window: 200_000 } : CONTEXT, rateLimits: LIMITS },
  }))
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.SessionStart', () => ({}))
  stubStore(on, new Map())
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))
  await $.session.start(START)

  cleared = true
  await $.classic.SessionStart({ source: 'clear' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '20%' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '—' })).toBeDefined()
})

test('a session left idle past the longest window stops showing its own reading', async ($, on) => {
  // Hand-driven clock: 8 days of 60 s ticks on the mock clock take longer than a test may run, so
  // time jumps the way it does over a machine's sleep, and one tick runs after it
  let now = NOW
  const ticks: (() => void)[] = []
  on('clock.now', () => ({ value: now }))
  on('clock.every', () => new Promise((resolve) => ticks.push(() => resolve({ value: undefined }))))
  stubSession(on, new Map(), [])
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure({ context: CONTEXT, rateLimits: [{ kind: 'spend_limit', percentUsed: 90 }], changed: ['rateLimits'] })

  now = NOW + 8 * 24 * HOUR + MINUTE
  expect(ticks).toHaveLength(1)
  ticks.pop()!()
  // The ticker asks for its next tick once this one has run
  for (let i = 0; i < 100 && ticks.length === 0; i++) await new Promise((r) => setTimeout(r, 0))
  expect(ticks).toHaveLength(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '90%' })).toBeUndefined()
})

test('/resume hands the old key over and writes under the new session id', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  let id = 'this'
  on('session.usage', () => ({ value: { startedAt: NOW, context: CONTEXT, rateLimits: [] } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('classic.SessionStart', () => ({}))
  stubStore(on, saved, () => {}, () => id)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))
  await $.session.start(START)
  await $.session.measure({ context: CONTEXT, rateLimits: LIMITS, changed: ['rateLimits'] })

  id = 'resumed'
  await $.classic.SessionStart({ source: 'resume' })
  // The old key held the newest reading, so it stays for the others, marked ended
  expect(saved.get(OWN)).toEqual({ at: NOW, limits: LIMITS, ended: true })

  await $.session.measure({ context: CONTEXT, rateLimits: [fiveHour(70, 2 * HOUR), LIMITS[1]!], changed: ['rateLimits'] })
  expect(saved.get('reading:resumed')).toEqual({ at: NOW, limits: [fiveHour(70, 2 * HOUR), LIMITS[1]!] })
  expect(saved.get(OWN)).toEqual({ at: NOW, limits: LIMITS, ended: true })
})

test('compaction keeps the same key', async ($, on) => {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  stubSession(on, saved)
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)

  await $.classic.SessionStart({ source: 'compact' })
  expect(saved.get(OWN)).toEqual({ at: NOW, limits: LIMITS })
})


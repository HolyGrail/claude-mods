import type { SessionContextUsage, SessionRateLimit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// 2026-10-01T12:00:00Z
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

function stubSession(on: On, saved: Map<string, unknown>, rateLimits = LIMITS, context = CONTEXT) {
  on('session.usage', () => ({ value: { startedAt: NOW, context, rateLimits } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  // What the mods after this one draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))
}

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

test('colors a limit by how far usage runs ahead of the time gone', async ($, on) => {
  mock.clock(on, { now: NOW })
  // 2.5 hours left of 5, so half the window is gone
  const half = 2.5 * HOUR
  stubSession(on, new Map(), [fiveHour(30, half), fiveHour(50, half), fiveHour(80, half)])
  await $.session.start(START)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '30% 2h30m' })).toMatchObject({ props: { color: 'success' } })
  expect(await ui.find({ type: 'Text', text: '50% 2h30m' })).toMatchObject({ props: { color: 'warning' } })
  expect(await ui.find({ type: 'Text', text: '80% 2h30m' })).toMatchObject({ props: { color: 'error' } })
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
    expect(await ui.find({ type: 'Text', text: '62% 2h13m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5% 4d18h' })).toMatchObject({ props: { color: 'success' } })
    expect(await ui.find({ type: 'Text', text: 'drawn by another mod' })).toBeDefined()
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
  expect(saved.get('rateLimits')).toEqual({ at: NOW, limits: rateLimits })
})

test('picks up a newer reading another session shared', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  // This session has no reading of its own yet
  stubSession(on, saved, [])
  await $.session.start(START)

  saved.set('rateLimits', { at: NOW + 1, limits: LIMITS })
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

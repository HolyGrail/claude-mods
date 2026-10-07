import type { AgentInfo, SessionRateLimit, TurnStepResult } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

const MINUTE = 60_000
const NOW = Date.UTC(2026, 9, 1, 12)
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

const BAND = {
  plugin: 'cache-meter',
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
type Engine = Parameters<TestBody>[0]
type Usage = NonNullable<TurnStepResult['usage']>

type Host = {
  env: Record<string, string>
  settings: Record<string, unknown>
  login: 'bearer' | 'api-key' | null
  rateLimits: SessionRateLimit[]
  // The usage the next model request reports
  usage: Usage | null
  // Holds a subagent's request until it resolves, so requests can answer out of order
  hold?: { agentId: string; until: Promise<void> }
}

function stubHost(on: On, host: Partial<Host> = {}): Host {
  const h: Host = { env: {}, settings: {}, login: 'bearer', rateLimits: [], usage: null, ...host }
  on('session.start', () => ({ cwd: '/work' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: h.rateLimits } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.authorize', () => ({ value: h.login ? { handle: 'h', kind: h.login } : null }))
  on('env.get', ($, e) => ({ value: h.env[e.name] }))
  on('settings.read', () => ({ value: h.settings }))
  on('turn.step', async function* ($, e) {
    const usage = h.usage
    if (h.hold && e.agentId === h.hold.agentId) await h.hold.until
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as TurnStepResult
  })
  on('classic.PostModelSwitch', () => ({}))
  on('classic.SessionStart', () => ({}))
  // What the mods after this one draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))
  return h
}

// A main-loop request; by default its response read 40,000 tokens from the cache and wrote 4,000
async function step($: Engine, h: Host, options: { agentId?: string; model?: string; usage?: Partial<Usage> } = {}) {
  const model = options.model ?? OPUS
  h.usage = { model, input_tokens: 500, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 4_000, output_tokens: 1_500, ...options.usage }
  const stream = $.turn.step({ turnId: 't', index: 0, model, messageCount: 3, ...(options.agentId && { agentId: options.agentId }) })
  for await (const _ of stream) {
    // The stub yields nothing
  }
  return stream.result
}

// The gauge's line as the band draws it, or undefined when it draws none
async function gauge($: Engine, surface: 'terminal' | 'desktop' = 'terminal', query: { key?: string; type?: string; text?: string } = { key: 'cache-meter' }) {
  const ui = await $.ui.mount({ ...BAND, surface })
  const found = await ui.find(query)
  await ui.unmount()
  return found
}

async function line($: Engine) {
  return (await gauge($))?.text
}

// The color of the gauge's first run, the label and the state, which reads exactly `head`
async function headColor($: Engine, head: string) {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const runs = await ui.findAll({ type: 'Text', text: head })
  await ui.unmount()
  return runs.find((run) => run.text === head)?.props.color
}

test('draws nothing before the first response, then counts the cache down from the last request', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  await $.session.start(START)
  await clock.settle()
  expect(await gauge($)).toBeUndefined()

  await step($, h)
  await clock.settle()
  // 40,000 of the 44,500 input tokens came from the cache
  expect(await line($)).toBe('cache ● ~1h██████████60m left · hit 90% · misses 0')
  expect(await headColor($, 'cache ● ~1h')).toBe('success')
  // Stacked above what the later mods draw
  expect(await gauge($, 'terminal', { type: 'Text', text: 'drawn by another mod' })).toBeDefined()

  // Under a fifth of the hour left, it turns yellow
  await clock.advance(49 * MINUTE)
  expect(await line($)).toBe('cache ● ~1h██░░░░░░░░11m left · hit 90% · misses 0')
  expect(await headColor($, 'cache ● ~1h')).toBe('warning')

  // The last minute counts by the second, and the expiry itself turns it red
  await clock.advance(10 * MINUTE + 7_000)
  expect(await line($)).toBe('cache ● ~1h░░░░░░░░░░53s left · hit 90% · misses 0')
  await clock.advance(53_000)
  expect(await line($)).toBe('cache ○ cold · next message re-caches 46k tokens')
  expect(await headColor($, 'cache ○ cold')).toBe('error')
})

test('counts a request that re-read what the cache had held as a miss, with its cause', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  await $.session.start(START)
  await step($, h)
  await clock.advance(61 * MINUTE)
  // After the hour, the whole prefix is written again
  await step($, h, { usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 46_000 } })
  await clock.settle()
  // 40,000 of 91,000 input tokens came from the cache
  expect(await line($)).toBe('cache ● ~1h██████████60m left · hit 44% · misses 1 (expired)')
})

test('leaves the main cache to the main loop: a subagent request does not refresh it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  await $.session.start(START)
  await step($, h)
  await clock.advance(50 * MINUTE)
  await step($, h, { agentId: 'a1', usage: { cache_read_input_tokens: 0 } })
  await clock.settle()
  expect(await line($)).toBe('cache ● ~1h██░░░░░░░░10m left · hit 90% · misses 0')
})

test('takes a fork’s first request, which reads the main conversation’s entry, as a refresh', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  const agents = [
    { id: 'f1', type: 'fork', description: 'fork' },
    { id: 'a1', type: 'Explore', description: 'look' },
  ] as AgentInfo[]
  on('agent.list', () => ({ value: agents }))
  await $.session.start(START)
  await step($, h)
  await clock.advance(50 * MINUTE)
  // A subagent that reads as much from a cache of its own is not a fork
  await step($, h, { agentId: 'a1', usage: { cache_read_input_tokens: 44_000 } })
  await clock.settle()
  expect(await line($)).toMatch(/10m left/)

  await step($, h, { agentId: 'f1', usage: { cache_read_input_tokens: 44_000 } })
  await clock.settle()
  expect(await line($)).toMatch(/60m left · hit 90% · misses 0$/)

  // The fork's later requests read its own longer entry
  await clock.advance(30 * MINUTE)
  await step($, h, { agentId: 'f1', usage: { cache_read_input_tokens: 48_000 } })
  await clock.settle()
  expect(await line($)).toMatch(/30m left/)
})

test('leaves the main cache cold when a fork’s first request missed it, whatever its later ones read', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  const agents = [{ id: 'f1', type: 'fork', description: 'fork' }] as AgentInfo[]
  on('agent.list', () => ({ value: agents }))
  await $.session.start(START)
  await step($, h)
  await clock.advance(61 * MINUTE)
  await step($, h, { agentId: 'f1', usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 46_000 } })
  await step($, h, { agentId: 'f1', usage: { cache_read_input_tokens: 46_000 } })
  await clock.settle()
  expect(await line($)).toBe('cache ○ cold · next message re-caches 46k tokens')
})

test('keeps the newest read when overlapping forks answer out of order', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  const agents = [
    { id: 'f1', type: 'fork', description: 'older' },
    { id: 'f2', type: 'fork', description: 'newer' },
  ] as AgentInfo[]
  on('agent.list', () => ({ value: agents }))
  await $.session.start(START)
  await step($, h)
  await clock.advance(20 * MINUTE)
  // The older fork's request goes out first and answers last
  let release = () => {}
  h.hold = { agentId: 'f1', until: new Promise<void>((resolve) => (release = resolve)) }
  const older = step($, h, { agentId: 'f1', usage: { cache_read_input_tokens: 44_000 } })
  await clock.advance(10 * MINUTE)
  await step($, h, { agentId: 'f2', usage: { cache_read_input_tokens: 44_000 } })
  await clock.settle()
  expect(await line($)).toMatch(/60m left/)
  release()
  await older
  await clock.settle()
  expect(await line($)).toMatch(/60m left/)
})

test('takes the model that answered, when a later mod sent the request elsewhere', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  await $.session.start(START)
  // The step names Opus, but Sonnet answers both requests
  await step($, h, { usage: { model: SONNET } })
  await step($, h, { usage: { model: SONNET } })
  await clock.settle()
  expect(await line($)).toMatch(/misses 0$/)

  await $.classic.PostModelSwitch({
    from_model: SONNET,
    to_model: SONNET,
    requested_model: 'sonnet',
    source: 'command',
    context_tokens: 52_000,
    prompt_cache_warm: true,
    cache_ttl: '1h',
    estimated_cache_write_usd: 0,
    pricing: 'catalog',
  })
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● ~1h/)
})

test('draws an SVG bar on the desktop, and none once the cache is cold', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  await $.session.start(START)
  await step($, h)
  await clock.settle()
  expect(await gauge($, 'desktop', { type: 'Svg' })).toMatchObject({ props: { width: 96, height: 10 } })

  await clock.advance(60 * MINUTE)
  expect(await gauge($, 'desktop', { type: 'Svg' })).toBeUndefined()
})

test('takes five minutes off a subscription: an API key, or plan usage past its limit', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { login: 'api-key' })
  await $.session.start(START)
  await step($, h)
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● ~5m.*5m left/)

  h.login = 'bearer'
  const over: SessionRateLimit[] = [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + 60 * MINUTE).toISOString() }]
  await $.session.measure({ context: { window: 200_000 }, rateLimits: over, changed: ['rateLimits'] })
  await step($, h)
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● ~5m/)

  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['rateLimits'] })
  await step($, h)
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● ~1h.*60m left/)
})

test('keeps the TTL each request was cached with when the plan usage changes after it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const over: SessionRateLimit[] = [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(NOW + 60 * MINUTE).toISOString() }]
  const h = stubHost(on, { rateLimits: over })
  await $.session.start(START)
  await step($, h)
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● ~5m.*5m left/)

  // The window resets, but the cache written on usage credits still lapses in five minutes
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['rateLimits'] })
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● ~5m.*5m left/)
  await clock.advance(5 * MINUTE)
  expect(await line($)).toBe('cache ○ cold · next message re-caches 46k tokens')
})

test('follows a TTL chosen in the environment or settings, in Claude Code’s order', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { login: 'api-key', settings: { promptCacheTtl: '1h' } })
  await $.session.start(START)
  await step($, h)
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● 1h.*60m left/)

  // The environment variable beats the setting, and FORCE_PROMPT_CACHING_5M beats both
  h.env.CLAUDE_CODE_PROMPT_CACHE_TTL = '5m'
  await step($, h)
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● 5m.*5m left/)

  h.env = { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', FORCE_PROMPT_CACHING_5M: '1' }
  await step($, h)
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● 5m/)

  // A value Claude Code ignores falls through to the next control
  h.env = { CLAUDE_CODE_PROMPT_CACHE_TTL: '30m', ENABLE_PROMPT_CACHING_1H: '1' }
  h.settings = {}
  await step($, h)
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● 1h/)
})

test('takes the TTL the engine states at a model switch, and shows the new model starting cold', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on, { login: 'api-key' })
  await $.session.start(START)
  await step($, h)
  await $.classic.PostModelSwitch({
    from_model: OPUS,
    to_model: SONNET,
    requested_model: 'sonnet',
    source: 'command',
    context_tokens: 52_000,
    prompt_cache_warm: true,
    cache_ttl: '1h',
    estimated_cache_write_usd: 0.3,
    pricing: 'catalog',
  })
  await clock.settle()
  expect(await line($)).toBe('cache ○ cold · model switch · next message re-caches 52k tokens')

  await step($, h, { model: SONNET, usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 52_000 } })
  await clock.settle()
  expect(await line($)).toMatch(/^cache ● 1h.*60m left · hit \d+% · misses 1 \(model switch\)$/)
})

test('marks /compact as a rebuild, not a miss, and /clear as nothing cached yet', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  await $.session.start(START)
  await step($, h)
  await $.classic.SessionStart({ source: 'compact' })
  await clock.settle()
  expect(await line($)).toBe('cache ○ rebuilding · next message caches the /compact summary')

  await step($, h, { usage: { cache_read_input_tokens: 5_000, cache_creation_input_tokens: 3_000 } })
  await clock.settle()
  expect(await line($)).toMatch(/misses 0$/)

  await $.classic.SessionStart({ source: 'clear' })
  await clock.settle()
  expect(await gauge($)).toBeUndefined()
})

test('dates a resumed conversation’s cache by its last response, and trusts the engine that it went cold', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubHost(on)
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, context_tokens: 120_000, prompt_cache_likely_expired: false })
  await clock.settle()
  expect(await line($)).toBe('cache ● ~1h████████░░50m left · misses 0')

  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, context_tokens: 1_250_000, prompt_cache_likely_expired: true })
  await clock.settle()
  expect(await line($)).toBe('cache ○ cold · next message re-caches 1.3M tokens')
})

test('says so when caching is off or the responses report none', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const h = stubHost(on)
  await $.session.start(START)
  await step($, h, { usage: { input_tokens: 9_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  await clock.settle()
  expect(await line($)).toBe('cache ○ off · no cache tokens reported')

  h.env.DISABLE_PROMPT_CACHING = '1'
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['rateLimits'] })
  await clock.settle()
  expect(await line($)).toBe('cache ○ off · DISABLE_PROMPT_CACHING')

  // A re-fired session.start does not carry the switch over before it reads the environment again
  delete h.env.DISABLE_PROMPT_CACHING
  await $.session.start(START)
  await clock.settle()
  expect(await gauge($)).toBeUndefined()
})

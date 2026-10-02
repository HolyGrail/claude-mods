import type { SessionMessage, SessionRepo } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.UTC(2026, 9, 1, 12)

const BAND = {
  plugin: 'notice-board',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  surface: 'terminal',
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

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const PRESENTATION = { isFullscreen: false, columns: 100 } as const

// The same repository as two worktrees see it, cloned over HTTPS and over SSH
const HTTPS: SessionRepo = { root: '/src/app', remote: 'https://github.com/owner/app.git', internal: false, name: null }
const SSH: SessionRepo = { root: '/elsewhere/app', remote: 'git@github.com:owner/app', internal: false, name: null }
const APP_KEY = 'github.com/owner/app'

// The stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

type Host = {
  // The store every session shares, by key
  store: Map<string, unknown>
  // Each line this session's model was told
  passedOn: string[]
  // The conversation, which a test may replace as /clear, /resume or /rewind does
  transcript: SessionMessage[]
}

// Backs $.store with a Map and the conversation with an array. A plugin's $.session.append never
// reaches a test's hooks and fails, so what the model is told is read from the debug line the
// failure logs, and that line stands in for the row the append would have added.
function stubHost(
  on: On,
  {
    store = new Map<string, unknown>(),
    repo = (): SessionRepo | null => HTTPS,
    keepsRows = true,
    // Holds a read of the conversation back, as a slow host would
    beforeRead = async (): Promise<void> => {},
    // Holds a read of the repository back
    beforeRepo = async (): Promise<void> => {},
    // What version 0.1 kept in $.state of the notices it told
    known = [] as { id: string; text: string }[],
  } = {},
): Host {
  const host: Host = { store, passedOn: [], transcript: [] }
  on('session.id', () => ({ value: 'this' }))
  on('session.messages', async () => {
    await beforeRead()
    return { value: host.transcript }
  })
  on('session.repo', async () => {
    await beforeRepo()
    return { value: repo() }
  })
  on('state.get', () => ({ value: { value: known, version: 0 } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    if (e.text.startsWith('notice-board could not tell the model: ')) {
      const row = e.text.slice(e.text.indexOf('\n') + 1)
      // The ref that signs the row is checked where it matters; the rest compare what the model reads
      host.passedOn.push(row.replace(REF, ''))
      if (keepsRows) host.transcript = [...host.transcript, said('user', row)]
    }
    return { value: undefined }
  })
  // What the mods after this one draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))
  return host
}

function said(role: 'user' | 'assistant', text: string): SessionMessage {
  return { role, text, toolUses: [] }
}

// The test environment has timers, which the es2023 lib the tsconfig names leaves untyped
const later = (globalThis as unknown as { setTimeout: (run: () => void, ms: number) => void }).setTimeout

// Lets the hooks already dispatched run up to their next wait on the host
function settle() {
  return new Promise<void>((resolve) => later(resolve, 5))
}

// Signs a row as the module does, with the secret it keeps in the store
async function signed(store: Map<string, unknown>, line: string, body: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(store.get('secret') + '\n' + body))
  const ref = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8)
  return line + '\n(notice-board ref ' + ref + ')'
}

const REF = /\n\(notice-board ref [0-9a-f]{8}\)$/

// The notices in the store, without the secret and the records kept beside them
function noticesIn(store: Map<string, unknown>) {
  return [...store].filter(([key]) => key.startsWith('notice:')).map(([, value]) => value)
}

function notice(text: string, repo: string | null, postedAt: number) {
  return { text, repo, postedAt }
}

function run($: Engine, args: string) {
  return $.command.run({ command: 'notice', args, origin: { kind: 'composer' }, presentation: PRESENTATION })
}

test('a posted notice is stored for the repository, shown here and told to this model once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const host = stubHost(on)
  await $.session.start(START)

  const { text } = await run($, 'CI is paused, check the Codex review only')
  expect(text).toBe('Posted to every session in this repository.')
  expect(noticesIn(host.store)).toEqual([notice('CI is paused, check the Codex review only', APP_KEY, NOW)])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'notice 0m:' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'CI is paused, check the Codex review only' })).toBeDefined()
  // What the other mods draw stays below
  expect(await ui.find({ type: 'Text', text: 'drawn by another mod' })).toBeDefined()
  // A command's output is not part of what the model reads, so the poster's model is told too
  const told = ['Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused, check the Codex review only']
  expect(host.passedOn).toEqual(told)
  await clock.advance(MINUTE)
  expect(host.passedOn).toEqual(told)
})

test("another worktree's notice reaches this session within a tick and the model once", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const host = stubHost(on, { repo: () => SSH })
  await $.session.start(START)
  expect(host.passedOn).toEqual([])

  host.store.set('notice:1-other', notice('CI is paused', APP_KEY, NOW))
  await clock.advance(MINUTE)
  const told = ['Notice to every Claude Code session in this repository, posted 1m ago with /notice: CI is paused']
  expect(host.passedOn).toEqual(told)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'notice 1m:' })).toBeDefined()

  await clock.advance(MINUTE)
  expect(host.passedOn).toEqual(told)
})

test("another repository's notices stay out, and --all ones reach every repository", async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([
    ['notice:1-lib', notice('lib only', 'github.com/owner/lib', NOW - HOUR)],
    ['notice:2-lib', notice('every session', null, NOW - 3 * HOUR)],
  ])
  const host = stubHost(on, { store })
  await $.session.start(START)

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'lib only' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'every session' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'notice (all) 3h:' })).toBeDefined()
  expect(host.passedOn).toEqual(['Notice to every Claude Code session on this machine, posted 3h ago with /notice: every session'])
})

test('/notice clear takes down what this session shows, and the others tell their models', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([
    ['notice:1-a', notice('CI is paused', APP_KEY, NOW)],
    ['notice:2-a', notice('every session', null, NOW)],
    ['notice:3-lib', notice('lib only', 'github.com/owner/lib', NOW)],
  ])
  const host = stubHost(on, { store })
  await $.session.start(START)

  expect((await run($, 'clear')).text).toBe('Cleared 2 notices.')
  expect([...store.keys()].filter((key) => key.startsWith('notice:'))).toEqual(['notice:3-lib'])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'CI is paused' })).toBeUndefined()
  await clock.advance(MINUTE)
  expect(host.passedOn).toEqual([
    'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused',
    'Notice to every Claude Code session on this machine, posted 0m ago with /notice: every session',
    'This notice no longer applies: CI is paused',
    'This notice no longer applies: every session',
  ])
  expect((await run($, 'clear')).text).toBe('No notices to clear.')
})

test('a notice another session cleared is withdrawn from the model and the band', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  const host = stubHost(on, { store })
  await $.session.start(START)

  store.delete('notice:1-a')
  await clock.advance(MINUTE)
  expect(host.passedOn).toEqual([
    'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused',
    'This notice no longer applies: CI is paused',
  ])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'CI is paused' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'drawn by another mod' })).toBeDefined()
})

test('the band shows the newest three and counts the rest', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>()
  for (let i = 1; i <= 5; i++) store.set('notice:' + i, notice('notice number ' + i, APP_KEY, NOW - i * MINUTE))
  stubHost(on, { store })
  await $.session.start(START)

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: 'notice number 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'notice number 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'notice number 4' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '+2 more' })).toBeDefined()
})

test('a reload keeps what the model was told, and /clear tells it again at the next tick', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  const host = stubHost(on, { store })
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  // An enable or a worker respawn fires session.start again
  await $.session.start(START)
  const told = 'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused'
  expect(host.passedOn).toEqual([told])

  host.transcript = []
  await $.classic.SessionStart({ source: 'clear' })
  await clock.advance(MINUTE)
  expect(host.passedOn).toEqual([told, told.replace('0m ago', '1m ago')])
})

test('a reload between /clear and the retelling still tells the new conversation', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  const host = stubHost(on, { store })
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  expect(host.passedOn).toHaveLength(1)

  host.transcript = []
  await $.classic.SessionStart({ source: 'clear' })
  await clock.advance(MINUTE / 2)
  // A hot reload starts the module over
  await $.session.start(START)
  expect(host.passedOn).toEqual([
    'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused',
    'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused',
  ])
  expect(host.transcript).toHaveLength(1)
})

test('outside a repository only --all can post', async ($, on) => {
  mock.clock(on, { now: NOW })
  const host = stubHost(on, { repo: () => null })
  await $.session.start(START)

  expect((await run($, 'hello')).text).toMatch(/^Not in a git repository/)
  expect((await run($, '--all hello')).text).toBe('Posted to every session on this machine.')
  expect(noticesIn(host.store)).toEqual([notice('hello', null, NOW)])
  expect((await run($, '--all')).text).toMatch(/^Usage/)
  expect((await run($, '')).text).toMatch(/^Usage/)
})

test('a repository without a remote is named by its main working tree', async ($, on) => {
  mock.clock(on, { now: NOW })
  const host = stubHost(on, { repo: () => ({ root: '/src/app', remote: null, internal: false, name: null }) })
  await $.session.start(START)

  await run($, 'hello')
  expect(noticesIn(host.store)).toEqual([notice('hello', 'path:/src/app', NOW)])
})

test('remotes keep a numeric owner, a port and the case of their path', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const remotes = [
    ['git@github.com:123/app.git', 'github.com/123/app'],
    ['https://GitHub.com/123/app', 'github.com/123/app'],
    ['ssh://git@git.example.com:2222/team/App.git', 'git.example.com:2222/team/App'],
    ['ssh://git@git.example.com:3333/team/App.git', 'git.example.com:3333/team/App'],
    ['ssh://git@[2001:db8::1]/team/App.git', '[2001:db8::1]/team/App'],
    ['git@[2001:db8::1]:/team/App.git', '[2001:db8::1]/team/App'],
    // Local remotes, whose spelling may be relative, fall back to the main working tree
    ['../upstream.git', 'path:/src/app'],
    ['file:///srv/app.git', 'path:/src/app'],
  ]
  let remote = ''
  const host = stubHost(on, { repo: () => ({ root: '/src/app', remote, internal: false, name: null }) })
  await $.session.start(START)

  for (const [spelled = ''] of remotes) {
    remote = spelled
    await run($, 'hello')
    // Each post at its own time, so each has its own key
    await clock.advance(1)
  }
  expect(noticesIn(host.store).map((n) => (n as { repo: string }).repo)).toEqual(remotes.map(([, key]) => key))
})

test('a cleared notice is not withdrawn while another notice shown carries its text', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', null, NOW)]])
  const host = stubHost(on, { store })
  await $.session.start(START)

  store.delete('notice:1-a')
  store.set('notice:2-b', notice('CI is paused', APP_KEY, NOW + MINUTE))
  await clock.advance(MINUTE)
  expect(host.passedOn).toEqual([
    'Notice to every Claude Code session on this machine, posted 0m ago with /notice: CI is paused',
    'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused',
  ])
})

test('/branch keeps what the fork copied, without telling it twice', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  const host = stubHost(on, { store })
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', ($, e) => e as never)
  await $.session.start(START)
  expect(host.passedOn).toHaveLength(1)

  // The fork copies the conversation, the notice with it; a reload right after changes nothing
  await $.classic.SessionStart({ source: 'fork' })
  await $.session.start(START)
  await clock.advance(MINUTE)
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never)
  expect(host.passedOn).toHaveLength(1)
})

test('a resumed conversation is told a notice it holds was cleared meanwhile, and given the ones it lacks', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:2-b', notice('Use the staging DB', APP_KEY, NOW)]])
  const host = stubHost(on, { store })
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', ($, e) => e as never)
  await $.session.start(START)
  expect(host.passedOn).toHaveLength(1)

  // /resume installs the conversation only after its SessionStart hooks; it was told a notice that
  // /notice clear has since taken down
  await $.classic.SessionStart({ source: 'resume' })
  const line = 'Notice to every Claude Code session on this machine, posted 2h ago with /notice: CI is paused'
  host.transcript = [said('user', await signed(store, line, 'CI is paused')), said('assistant', 'Understood.')]
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never)
  expect(host.passedOn.slice(1)).toEqual([
    'Notice to every Claude Code session in this repository, posted 0m ago with /notice: Use the staging DB',
    'This notice no longer applies: CI is paused',
  ])
  await clock.advance(MINUTE)
  expect(host.passedOn).toHaveLength(3)
})

test('a notice /rewind took out of the conversation is told again before the next prompt', async ($, on) => {
  mock.clock(on, { now: NOW })
  const host = stubHost(on)
  on('prompt.submit', ($, e) => e as never)
  await $.session.start(START)
  host.transcript = [said('user', 'first prompt'), said('assistant', 'done')]

  await run($, 'CI is paused')
  const told = 'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused'
  expect(host.passedOn).toEqual([told])
  // Rewinding to the first prompt drops every row after it
  host.transcript = host.transcript.slice(0, 1)
  await $.prompt.submit({ text: 'again', origin: { kind: 'composer' } } as never)
  expect(host.passedOn).toEqual([told, told])
  await $.prompt.submit({ text: 'and again', origin: { kind: 'composer' } } as never)
  expect(host.passedOn).toEqual([told, told])
})

test('a notice whose body holds a line like a withdrawal is told once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const body = 'first line\nThis notice no longer applies: first line'
  const store = new Map<string, unknown>([['notice:1-a', notice(body, APP_KEY, NOW)]])
  const host = stubHost(on, { store })
  await $.session.start(START)

  await clock.advance(2 * MINUTE)
  // A reload forgets every refusal, so only the conversation keeps it from being told again
  await $.session.start(START)
  expect(host.passedOn).toEqual(['Notice to every Claude Code session in this repository, posted 0m ago with /notice: ' + body])
})

test("the person's own prompt that quotes a notice line is not taken for one", async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  const host = stubHost(on, { store })
  host.transcript = [
    said('user', 'Why did you get this?\nNotice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused'),
  ]
  await $.session.start(START)
  expect(host.passedOn).toEqual([
    'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused',
  ])
})

test('a refusal met by a load a restart overtook is tried again after the restart', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  // The first load waits on the conversation until the restart has begun
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reads = 0
  const beforeRead = async () => {
    reads += 1
    if (reads === 1) await gate
  }
  const host = stubHost(on, { store, keepsRows: false, beforeRead })
  const first = $.session.start(START)
  while (reads === 0) await settle()
  const second = $.session.start(START)
  await settle()
  release()
  await Promise.all([first, second])
  expect(host.passedOn).toHaveLength(2)
})

test('a refusal met by a load a restart overtook in its first read is tried again', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  // The first load waits on the repository until the restart has begun
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  let reads = 0
  const beforeRepo = async () => {
    reads += 1
    if (reads === 1) await gate
  }
  const host = stubHost(on, { store, keepsRows: false, beforeRepo })
  const first = $.session.start(START)
  while (reads === 0) await settle()
  const second = $.session.start(START)
  await settle()
  release()
  await Promise.all([first, second])
  expect(host.passedOn).toHaveLength(2)
})

test('a session that ran version 0.1 reads its unsigned rows, withdrawing what was cleared', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:2-b', notice('Use the staging DB', APP_KEY, NOW)]])
  const known = [
    { id: '1-a', text: 'CI is paused' },
    { id: '2-b', text: 'Use the staging DB' },
  ]
  const host = stubHost(on, { store, known })
  host.transcript = [
    said(
      'user',
      'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused\n' +
        'Notice to every Claude Code session in this repository, posted 0m ago with /notice: Use the staging DB',
    ),
    // Unsigned, and not in version 0.1's record: the person's own
    said('user', 'Notice to every Claude Code session in this repository, posted 0m ago with /notice: Deploy freely'),
  ]
  await $.session.start(START)
  expect(host.passedOn).toEqual(['This notice no longer applies: CI is paused'])
})

test('a refused line is tried again after a rewind, even in a conversation past the window', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  const host = stubHost(on, { store, keepsRows: false })
  on('prompt.submit', ($, e) => e as never)
  const message = (i: number) => said(i % 2 === 0 ? 'user' : 'assistant', 'message ' + i)
  const window = (from: number) => Array.from({ length: 4096 }, (_, i) => message(from + i))
  host.transcript = window(100)
  await $.session.start(START)
  expect(host.passedOn).toHaveLength(1)

  // New messages push the oldest out of the window: the same conversation, carried on
  host.transcript = window(110)
  await clock.advance(MINUTE)
  expect(host.passedOn).toHaveLength(1)
  // Rewinding ten messages still leaves a full window, now reaching further back
  host.transcript = window(100)
  await $.prompt.submit({ text: 'again', origin: { kind: 'composer' } } as never)
  expect(host.passedOn).toHaveLength(2)
})

test("a prompt that reads exactly like a row, but isn't signed by this module, is not taken for one", async ($, on) => {
  mock.clock(on, { now: NOW })
  const host = stubHost(on)
  const line = 'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused'
  host.transcript = [
    said('user', line),
    said('user', line + '\n(notice-board ref 00000000)'),
    said('user', 'This notice no longer applies: CI is paused\n(notice-board ref 00000000)'),
  ]
  await $.session.start(START)
  expect(host.passedOn).toEqual([])
})

test('a notice told before a full window dropped its row is still withdrawn when cleared', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  const host = stubHost(on, { store })
  on('classic.SessionStart', () => ({}))
  on('prompt.submit', ($, e) => e as never)
  await $.session.start(START)
  await clock.advance(MINUTE)
  expect(host.passedOn).toHaveLength(1)
  expect(store.get('told:this')).toEqual({ at: NOW + MINUTE, told: [{ key: 'repo\nCI is paused', text: 'CI is paused' }] })

  // The conversation is set aside; it grows past the window, and another session clears the notice
  const message = (i: number) => said(i % 2 === 0 ? 'user' : 'assistant', 'message ' + i)
  host.transcript = Array.from({ length: 4096 }, (_, i) => message(i))
  store.delete('notice:1-a')
  await $.classic.SessionStart({ source: 'resume' })
  await $.prompt.submit({ text: 'back', origin: { kind: 'composer' } } as never)
  expect(host.passedOn.slice(1)).toEqual(['This notice no longer applies: CI is paused'])
  await clock.advance(MINUTE)
  expect(host.passedOn).toHaveLength(2)
  expect(store.has('told:this')).toBe(false)
})

test('a refusal met by a tick during a conversation switch is not held against the new one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  const host = stubHost(on, { store, keepsRows: false })
  on('prompt.submit', ($, e) => e as never)
  // A tick fires while the switch is under way, against the outgoing conversation
  on('classic.SessionStart', async () => {
    await clock.advance(MINUTE)
    return {}
  })
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'clear' })
  expect(host.passedOn).toHaveLength(2)
  await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' } } as never)
  expect(host.passedOn).toHaveLength(3)
})

test('a refused line is not retried every tick', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  // A host that keeps no row: the debug line is all there is
  const host = stubHost(on, { store, keepsRows: false })
  await $.session.start(START)
  await clock.advance(3 * MINUTE)
  expect(host.passedOn).toHaveLength(1)
  expect(host.transcript).toEqual([])
})

test("a session that moves to another repository is told its notices no longer apply", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>([['notice:1-a', notice('CI is paused', APP_KEY, NOW)]])
  let repo = HTTPS
  const host = stubHost(on, { store, repo: () => repo })
  await $.session.start(START)

  repo = { root: '/src/lib', remote: 'https://github.com/owner/lib.git', internal: false, name: null }
  await clock.advance(MINUTE)
  expect(host.passedOn).toEqual([
    'Notice to every Claude Code session in this repository, posted 0m ago with /notice: CI is paused',
    'This notice no longer applies: CI is paused',
  ])
  expect([...store.keys()].filter((key) => key.startsWith('notice:'))).toEqual(['notice:1-a'])
})

test('two posts in the same millisecond keep both notices', async ($, on) => {
  mock.clock(on, { now: NOW })
  const host = stubHost(on)
  await $.session.start(START)

  await Promise.all([run($, 'first'), run($, 'second')])
  expect(noticesIn(host.store).map((n) => (n as { text: string }).text).sort()).toEqual(['first', 'second'])
})

test('a session that ends stops picking up notices', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>()
  const host = stubHost(on, { store })
  on('session.end', () => ({ sessionId: 'this' }))
  await $.session.start(START)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'this', resume: { id: '' } })
  store.set('notice:1-other', notice('CI is paused', APP_KEY, NOW))
  await clock.advance(MINUTE)
  expect(host.passedOn).toEqual([])
})

// Stands in for pr-relay, which posts through /notice when it sees a merge: its $.store is its own,
// so it can't write the notice keys itself. An inline plugin loads on its own, apart from this file.
const RELAY = {
  name: 'pr-relay',
  register: (on: On) => {
    on('session.start', async ($, e, next) => {
      $.clock.after(60_000, () =>
        $.command.run({ command: 'notice', args: 'main advanced (#12). Rebase before the next push.' }),
      )
      return next(e)
    })
  },
}

test('another plugin posts through $.command.run, as pr-relay does on a merge', { plugins: [RELAY] }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const host = stubHost(on)
  await $.session.start(START)

  await clock.advance(MINUTE)
  expect(noticesIn(host.store)).toEqual([notice('main advanced (#12). Rebase before the next push.', APP_KEY, NOW + MINUTE)])
  await clock.advance(MINUTE)
  expect(host.passedOn).toEqual([
    'Notice to every Claude Code session in this repository, posted 0m ago with /notice: main advanced (#12). Rebase before the next push.',
  ])
})

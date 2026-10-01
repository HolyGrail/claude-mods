import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000
const NOW = Date.UTC(2026, 9, 1, 12)
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

const URL = 'https://github.com/HolyGrail/claude-mods/pull/7'
const WORKTREE = '/repo/.wt/feature'
const LAST_PUSH = NOW - 30 * MINUTE

const BAND = {
  plugin: 'pr-relay',
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

const START = { surface: 'terminal', isInteractive: true, cwd: WORKTREE } as const

// The stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

type Pull = {
  state?: 'OPEN' | 'MERGED' | 'CLOSED'
  committedAt?: number
  thumbsUpAt?: number
  reviews?: { id: number; at: number; comments: number }[]
  comments?: { at: number; body: string }[]
}

// What gh api graphql answers for a pull request in this state
function graphql(pull: Pull) {
  const pullRequest = {
    state: pull.state ?? 'OPEN',
    commits: { nodes: [{ commit: { committedDate: iso(pull.committedAt ?? LAST_PUSH - 5 * MINUTE) } }] },
    reactionGroups: [
      {
        content: 'THUMBS_UP',
        reactors: {
          edges: pull.thumbsUpAt ? [{ reactedAt: iso(pull.thumbsUpAt), node: { login: 'chatgpt-codex-connector' } }] : [],
        },
      },
    ],
    reviews: {
      nodes: (pull.reviews ?? []).map((r) => ({
        databaseId: r.id,
        submittedAt: iso(r.at),
        author: { login: 'chatgpt-codex-connector' },
        comments: { totalCount: r.comments },
      })),
    },
    comments: {
      nodes: (pull.comments ?? []).map((c) => ({ createdAt: iso(c.at), author: { login: 'chatgpt-codex-connector' }, body: c.body })),
    },
  }
  return JSON.stringify({ data: { repository: { pullRequest } } })
}

type World = {
  pull: Pull
  // The /dev session files, by name
  devSessions: Record<string, unknown>
  // What gh pr view answers for the branch, or null when it has no pull request
  branchPr: { url: string; state: string } | null
  store: Map<string, unknown>
  prompts: string[]
  toasts: string[]
  status: string | undefined
  queries: number
}

function devSession(overrides: Record<string, unknown> = {}) {
  return {
    worktree_path: WORKTREE,
    pr_url: URL,
    status: 'pr-open',
    review: { last_push_at: iso(LAST_PUSH) },
    ...overrides,
  }
}

function stubWorld(on: On, world: Partial<World> = {}): World {
  const w: World = {
    pull: {},
    devSessions: { 'feature.json': devSession() },
    branchPr: null,
    store: new Map(),
    prompts: [],
    toasts: [],
    status: undefined,
    queries: 0,
    ...world,
  }
  mock.env(on, { HOME: '/home' })
  on('session.start', () => ({ cwd: WORKTREE }))
  on('session.cwd', () => ({ value: WORKTREE }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__pr-relay__${e.name}` } }))
  on('fs.list', () => ({
    value: Object.keys(w.devSessions).map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', ($, e) => ({ value: JSON.stringify(w.devSessions[e.path.split('/').pop() ?? '']) }))
  on('process.run', ($, e) => {
    const run = (exitCode: number, stdout: string) => ({
      value: { exitCode, stdout, stderr: exitCode ? 'no pull requests found' : '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[1] === 'pr') return w.branchPr ? run(0, JSON.stringify(w.branchPr)) : run(1, '')
    w.queries += 1
    return run(0, graphql(w.pull))
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', ($, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.status = e.text
    return { value: undefined }
  })
  // What the mods after this one draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))
  return w
}

test('watches the pull request of the /dev session whose worktree the session runs in', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    devSessions: {
      'other.json': devSession({ worktree_path: '/repo/.wt/other', pr_url: 'https://github.com/HolyGrail/claude-mods/pull/3' }),
      'feature.json': devSession(),
    },
  })
  await $.session.start(START)
  // The pull request is looked up once the session is ready
  await clock.settle()
  await clock.settle()

  expect(w.queries).toBe(1)
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認')
  expect(w.prompts).toEqual([])
})

test('a thumbs-up from before the last push is not an approval', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { thumbsUpAt: LAST_PUSH - 10 * MINUTE } })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])

  // Codex reacts again after the push: GitHub keeps one reaction, now with the new time
  w.pull.thumbsUpAt = NOW + 30_000
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('Codex が PR #7 (' + URL + ') を approved にしました')])

  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
})

test('a new Codex review wakes the session once, and not another session on the same pull request', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: LAST_PUSH - MINUTE, comments: 1 }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])

  w.pull.reviews?.push({ id: 2, at: NOW + 10_000, comments: 2 })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件、inline コメント 2 件')])

  await clock.advance(MINUTE)
  // A session started later on the same pull request reads what was relayed from the store
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts.length).toBe(1)
})

test('the usage limit shows a toast and wakes nobody', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { comments: [{ at: NOW - MINUTE, body: 'You have reached your Codex usage limits for code reviews.' }] },
  })
  await $.session.start(START)
  await clock.settle()

  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual(['PR #7: Codex の利用上限に達し、レビューが付きません'])
})

test('a merge stops the polling and offers the cleanup in the band', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  w.pull.state = 'MERGED'
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual(['PR #7 がマージされました'])
  expect(w.status).toBe('PR #7 マージ済み')
  expect(w.prompts).toEqual([])

  await clock.advance(5 * MINUTE)
  expect(w.queries).toBe(2)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'PR #7 がマージされました' })).toBeDefined()
  await ui.press({ key: 'cleanup' })
  expect(w.prompts).toEqual([expect.stringContaining('/dev cleanup')])
  expect(await ui.find({ key: 'cleanup' })).toBeUndefined()
})

test('a pull request the session creates is watched from then on', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {} })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: URL + '\n', stderr: '', interrupted: false }, text: URL }) as never)
  await $.session.start(START)
  await clock.settle()
  expect(w.queries).toBe(0)

  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title t --body-file "$BODY"' })
  expect(w.queries).toBe(1)
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認')
})

test('a push moves the baseline, so a thumbs-up from before it is not an approval', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // Codex approved the previous push; the session pushes again and the reaction keeps its time
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(30_000)
  expect(w.prompts).toEqual([])
})

test('waiting for Codex with poll-codex-review.sh --watch is refused while the pull request is watched', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '{}', stderr: '', interrupted: false }, text: '{}' }) as never)
  await $.session.start(START)
  await clock.settle()

  const watched = await $.tool.call({ tool: 'Bash', command: 'poll-codex-review.sh HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch' })
  expect(watched.deny).toContain('End the turn')

  const once = await $.tool.call({ tool: 'Bash', command: 'poll-codex-review.sh HolyGrail/claude-mods 7 2026-10-01T11:30:00Z' })
  expect(once.deny).toBeUndefined()
})

test('the watch tool reports what is watched and watches the pull request it is given', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {} })
  await $.session.start(START)
  await clock.settle()

  const idle = await $.tool.call({ tool: 'mcp__pr-relay__watch' })
  expect(idle.result).toBe('pr-relay is not watching a pull request in this session.')

  const watching = await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL, since: iso(LAST_PUSH) })
  expect(watching.result).toContain(`pr-relay is watching ${URL}`)
  expect(w.queries).toBe(1)
})

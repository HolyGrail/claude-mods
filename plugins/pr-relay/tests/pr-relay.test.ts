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
  head?: string
  committedAt?: number
  thumbsUpAt?: number
  reviews?: { id: number; at: number; comments: number }[]
  comments?: { at: number; body: string }[]
}

// What gh api graphql answers for a pull request in this state
function graphql(pull: Pull) {
  const pullRequest = {
    state: pull.state ?? 'OPEN',
    headRefOid: pull.head ?? 'a1',
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
  // What gh pr view answers for the branch, null when it has no pull request, or 'error' when gh fails
  branchPr: { url: string; state: string } | null | 'error'
  // What a submitted prompt waits for before its turn starts
  turnStarts: () => Promise<void>
  // The argument vectors of the gh api calls
  queryArgv: (readonly string[])[]
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
    queryArgv: [],
    turnStarts: async () => {},
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
    const run = (exitCode: number, stdout: string, stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[1] === 'pr') {
      if (w.branchPr === 'error') return run(1, '', 'error connecting to api.github.com')
      return w.branchPr ? run(0, JSON.stringify(w.branchPr)) : run(1, '', 'no pull requests found for branch "feature"')
    }
    w.queries += 1
    w.queryArgv.push(e.argv)
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
  on('prompt.submit', async ($, e) => {
    w.prompts.push(e.text)
    await w.turnStarts()
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
      // The checkout the worktree is nested in has a session of its own
      'parent.json': devSession({ worktree_path: '/repo', pr_url: 'https://github.com/HolyGrail/claude-mods/pull/2' }),
      'feature.json': devSession(),
    },
  })
  await $.session.start(START)
  // The pull request is looked up once the session is ready
  await clock.settle()

  expect(w.queries).toBe(1)
  // The repository goes as a string whatever it is named, the number as a number
  expect(w.queryArgv[0]).toEqual(expect.arrayContaining(['-f', 'owner=HolyGrail', '-f', 'name=claude-mods', '-F', 'number=7']))
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

test('a pull request the session creates is watched from then on, without holding up the call', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // Codex reviews it as soon as it opens, before the first poll
  const w = stubWorld(on, {
    devSessions: {},
    pull: { reviews: [{ id: 1, at: NOW + 20_000, comments: 1 }] },
    // A plugin's prompt starts its turn only once the session is idle, so it resolves after the
    // running turn, which this tool call belongs to, has ended
    turnStarts: () => clock.sleep(10 * MINUTE),
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: URL + '\n', stderr: '', interrupted: false }, text: URL }) as never)
  await $.session.start(START)
  await clock.settle()
  expect(w.queries).toBe(0)

  await clock.advance(2_000)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title t --body-file "$BODY"' })
  await clock.settle()
  expect(w.queries).toBe(1)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
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
  w.pull.head = 'b2'
  await clock.advance(30_000)
  expect(w.prompts).toEqual([])
})

test('a push that leaves the head where it was keeps the baseline', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: 'Everything up-to-date', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // Codex approves the head between two polls, and a push then changes nothing
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(30_000)
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました')])
})

test('a push the /dev session file records moves the baseline too', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  // The push went unseen here (git -C, a script); the skill recorded it after the old thumbs-up
  w.pull.thumbsUpAt = NOW + 10_000
  w.devSessions['feature.json'] = devSession({ review: { last_push_at: iso(NOW + 20_000) } })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
})

test('a pull request gh could not look up at startup is looked up again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {}, branchPr: 'error' })
  await $.session.start(START)
  await clock.settle()
  expect(w.queries).toBe(0)

  w.branchPr = { url: URL, state: 'OPEN' }
  await clock.advance(MINUTE)
  expect(w.queries).toBe(1)
  expect(w.status).toBe('PR #7 監視中 · 21:01 確認')
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
  await clock.settle()
  expect(w.queries).toBe(1)
})

test('the worktree that holds the cwd decides, even before its pull request exists', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    devSessions: {
      'parent.json': devSession({ worktree_path: '/repo', pr_url: 'https://github.com/HolyGrail/claude-mods/pull/2' }),
      'feature.json': devSession({ status: 'in-progress', pr_url: null }),
    },
  })
  await $.session.start(START)
  await clock.settle()

  expect(w.queries).toBe(0)
  expect(w.status).toBeUndefined()
})

test('a review that comes after an approval is relayed on its own', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { thumbsUpAt: NOW - 10 * MINUTE, reviews: [{ id: 1, at: NOW - 5 * MINUTE, comments: 3 }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました')])

  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました'), expect.stringContaining('inline コメント 3 件')])
})

test('a pull request watched before /dev records it follows the session file once it does', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {} })
  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.settle()

  // The skill records the PR and, later, a push this module did not see; the old thumbs-up stays
  w.devSessions['feature.json'] = devSession({ review: { last_push_at: iso(NOW + 20_000) } })
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
})

test('a reopened pull request is reported again when it closes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  w.store.set('pr:' + URL.toLowerCase(), { since: LAST_PUSH, head: 'a1', approvedAt: 0, usageLimitAt: 0, reviews: [], ended: 'CLOSED', at: NOW - MINUTE })
  await $.session.start(START)
  await clock.settle()

  w.pull.state = 'MERGED'
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual(['PR #7 がマージされました'])
})

test('a push made for one pull request does not move the baseline of the next one watched', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {}, branchPr: { url: 'https://github.com/HolyGrail/claude-mods/pull/3', state: 'OPEN' } })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // The push to #3 is still waiting for its head when the session turns to #7, which Codex
  // approved before that push
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL, since: iso(LAST_PUSH) })
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('PR #7')])
})

test('a prompt that does not enter is sent again on the next poll', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let refusals = 1
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] },
    turnStarts: async () => {
      if (refusals-- > 0) throw new Error('the queue is closed')
    },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts.length).toBe(1)

  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(2)
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(2)
})

test('a pull request found after a push takes that push as its baseline', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {} })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // The branch's pull request shows up once pushed; Codex approved an older push of it
  w.branchPr = { url: URL, state: 'OPEN' }
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.pull.head = 'b2'
  await clock.settle()
  expect(w.queries).toBe(1)
  expect(w.prompts).toEqual([])
})

test('the same pull request spelled in another case is one pull request', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts.length).toBe(1)

  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: 'https://github.com/holygrail/Claude-Mods/pull/7' })
  await clock.settle()
  expect(w.prompts.length).toBe(1)
  expect([...w.store.keys()]).toEqual(['pr:' + URL.toLowerCase()])
})

test('taking back a prompt that did not enter leaves what a later approval settled', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let release = () => {}
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] },
    // The review prompt waits for its turn, and then does not enter
    turnStarts: () =>
      w.prompts.length === 1
        ? new Promise<void>((_, reject) => {
            release = () => reject(new Error('the queue is closed'))
          })
        : Promise.resolve(),
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])

  // Codex approves after the review, before the review prompt fails
  w.pull.thumbsUpAt = NOW + 30_000
  await clock.advance(MINUTE)
  expect(w.prompts[1]).toContain('approved にしました')
  release()
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(2)
})

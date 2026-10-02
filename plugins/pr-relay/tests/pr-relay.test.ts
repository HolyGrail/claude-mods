import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60_000
const NOW = Date.UTC(2026, 9, 1, 12)
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

const URL = 'https://github.com/HolyGrail/claude-mods/pull/7'
const WORKTREE = '/repo/.wt/feature'
const LAST_PUSH = NOW - 30 * MINUTE
const POLL = '~/.claude/skills/dev/references/scripts/poll-codex-review.sh'

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
  // The pull request's branch
  branch?: string
  committedAt?: number
  thumbsUpAt?: number
  reviews?: { id: number; at: number; comments: number; by?: string; pending?: true }[]
  // Reviews on the page before the newest, which gh hands out for the cursor 'older'
  olderReviews?: { id: number; at: number; comments: number; by?: string }[]
  comments?: { at: number; body: string }[]
}

const reviewNodes = (reviews: NonNullable<Pull['reviews']>) =>
  reviews.map((r) => ({
    databaseId: r.id,
    submittedAt: 'pending' in r && r.pending ? null : iso(r.at),
    author: { login: r.by ?? 'chatgpt-codex-connector' },
    comments: { totalCount: r.comments },
  }))

// What gh api graphql answers for a pull request in this state, or for the page before
function graphql(pull: Pull, before?: string) {
  if (before === 'older') {
    return JSON.stringify({
      data: { repository: { pullRequest: { reviews: { pageInfo: { hasPreviousPage: false }, nodes: reviewNodes(pull.olderReviews ?? []) } } } },
    })
  }
  const pullRequest = {
    state: pull.state ?? 'OPEN',
    headRefOid: pull.head ?? 'a1',
    headRefName: pull.branch ?? 'feature',
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
      pageInfo: { hasPreviousPage: Boolean(pull.olderReviews), startCursor: 'older' },
      nodes: reviewNodes(pull.reviews ?? []),
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
  // What gh api graphql waits for before it answers
  answers: () => Promise<void>
  // What reading a /dev session file waits for
  reads: () => Promise<void>
  // What gh api graphql fails with, when it does
  queryError?: string
  // What writing a poll note fails with, when it does
  noteError?: string
  // What listing the store fails with, when it does
  keysError?: string
  // What reading a key of the store waits for before it answers what the key held when asked
  gets?: (key: string) => Promise<void>
  // What writing a key of the store waits for before the value lands
  sets?: (key: string) => Promise<void>
  // Whether reading a key of the store fails
  getFails?: (key: string) => boolean
  // What asking for the session id waits for
  ids?: () => Promise<void>
  // The pull requests other than the one in pull, by number
  pulls?: Record<number, Pull>
  // The argument vectors of the gh api calls
  queryArgv: (readonly string[])[]
  store: Map<string, unknown>
  // The keys deleted from the store, in order
  deleted: string[]
  prompts: string[]
  toasts: string[]
  status: string | undefined
  queries: number
  sessionId: string
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
    deleted: [],
    prompts: [],
    toasts: [],
    status: undefined,
    queries: 0,
    sessionId: 'session-b',
    queryArgv: [],
    turnStarts: async () => {},
    answers: async () => {},
    reads: async () => {},
    ...world,
  }
  mock.env(on, { HOME: '/home' })
  on('session.start', () => ({ cwd: WORKTREE }))
  on('session.cwd', () => ({ value: WORKTREE }))
  on('session.id', async () => {
    await w.ids?.()
    return { value: w.sessionId }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__pr-relay__${e.name}` } }))
  on('fs.list', () => ({
    value: Object.keys(w.devSessions).map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', async ($, e) => {
    await w.reads()
    return { value: JSON.stringify(w.devSessions[e.path.split('/').pop() ?? '']) }
  })
  on('process.run', async ($, e) => {
    const run = (exitCode: number, stdout: string, stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[1] === 'pr') {
      if (w.branchPr === 'error') return run(1, '', 'error connecting to api.github.com')
      return w.branchPr ? run(0, JSON.stringify(w.branchPr)) : run(1, '', 'no pull requests found for branch "feature"')
    }
    w.queries += 1
    w.queryArgv.push(e.argv)
    await w.answers()
    if (w.queryError) return run(1, '', w.queryError)
    const before = e.argv.find((arg) => arg.startsWith('before='))?.slice('before='.length)
    const number = Number(e.argv.find((arg) => arg.startsWith('number='))?.slice('number='.length))
    return run(0, graphql(w.pulls?.[number] ?? w.pull, before))
  })
  on('store.keys', () => {
    if (w.keysError) throw new Error(w.keysError)
    return { value: [...w.store.keys()] }
  })
  on('store.get', async ($, e) => {
    if (w.getFails?.(e.key)) throw new Error('store busy')
    const value = w.store.get(e.key)
    await w.gets?.(e.key)
    return { value }
  })
  on('store.set', async ($, e) => {
    if (w.noteError && e.key.startsWith('poll:')) throw new Error(w.noteError)
    await w.sets?.(e.key)
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.deleted.push(e.key)
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
  // The status line says the watch has not started, rather than staying empty
  expect(w.status).toBe('PR 検索失敗 21:00: error connecting to api.github.com')

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

  for (const command of [
    `${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    `${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch --max-wait 540 2>&1`,
    `bash ${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    `cd /repo && "${POLL}" HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    // The /dev skill's documented form
    'SCRIPT="$REPO_ROOT/.claude/skills/dev/references/scripts/poll-codex-review.sh"\n' +
      '"$SCRIPT" "$OWNER/$REPO" "$PR_NUMBER" "$LAST_PUSH_AT" --watch --max-wait 540',
    `2>/tmp/poll.err ${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    `</dev/null >>/tmp/poll.log ${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    // The delimiter is EOF once its quotes are removed, so the call after the body still counts
    `cat <<'E'OF\nbody\nEOF\n${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    `export SCRIPT=${POLL}\n"$SCRIPT" HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    `/bin/bash ${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    `timeout -s TERM 600 ${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    `(SCRIPT=${POLL}; "$SCRIPT" HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch)`,
    `timeout --signal TERM 600 ${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    `source ${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    `. ${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    // Bash drops a backslash-newline inside double quotes
    '"/x/poll-codex-review.\\\nsh" HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch',
  ]) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.deny).toContain('End the turn')
  }
})

test('poll-codex-review.sh run without --watch, or only mentioned, is let through', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '{}', stderr: '', interrupted: false }, text: '{}' }) as never)
  await $.session.start(START)
  await clock.settle()

  for (const command of [
    `${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z`,
    'SCRIPT=~/x/poll-codex-review.sh\n"$SCRIPT" HolyGrail/claude-mods 7 2026-10-01T11:30:00Z && gh pr checks 7 --watch',
    "git commit -F - <<'EOF'\nNarrow the deny\n\npoll-codex-review.sh --watch was matched anywhere.\nEOF",
    'git commit -F - <<-EOF\n\tpoll-codex-review.sh --watch\n\tEOF\ngit status',
    'gh pr create --title "Narrow the deny" --body "It denied any mention of poll-codex-review.sh --watch"',
    "gh pr create --body 'poll-codex-review.sh --watch' --base main",
    `echo done # then ${POLL} HolyGrail/claude-mods 7 now --watch`,
    `SCRIPT=${POLL}; SCRIPT=/bin/echo; "$SCRIPT" --watch`,
    `bash -n ${POLL} HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`,
    // The subshell's assignment does not reach the parent
    `SCRIPT=/bin/echo; (SCRIPT=${POLL}); "$SCRIPT" --watch`,
    // An assignment before a command word lasts only for that command
    `SCRIPT=/bin/echo; SCRIPT=${POLL} /bin/true; "$SCRIPT" --watch`,
    `SCRIPT=${POLL}; '$SCRIPT' --watch`,
    `SCRIPT=${POLL}; "\\$SCRIPT" --watch`,
    `command -v ${POLL} --watch`,
    // In double quotes the backslash before O stays, so the body ends only at E\\OF
    `cat <<"E\\OF"\nEOF\n${POLL} HolyGrail/claude-mods 7 now --watch\nE\\OF`,
  ]) {
    const ran = await $.tool.call({ tool: 'Bash', command })
    expect(ran.deny).toBeUndefined()
  }
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
    // The branch has an older pull request of its own
    branchPr: { url: 'https://github.com/HolyGrail/claude-mods/pull/5', state: 'OPEN' },
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
  const pushed = '   a1a1a1a..b2b2b2b  feature -> feature\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  // The branch's pull request shows up once pushed; Codex approved an older push of it
  w.branchPr = { url: URL, state: 'OPEN' }
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.pull.head = 'b2b2b2b0123456789'
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
  expect([...w.store.keys()].filter((key) => key.startsWith('pr:'))).toEqual(['pr:' + URL.toLowerCase()])
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

test('a prompt taken back while the next poll waits on GitHub is sent again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let sent = 0
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] },
    // The first prompt waits a minute for its turn and then does not enter
    turnStarts: () => (sent++ === 0 ? clock.sleep(MINUTE + 1_000).then(() => Promise.reject(new Error('closed'))) : Promise.resolve()),
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts.length).toBe(1)

  // The next poll's query is in flight when the prompt is taken back
  w.answers = () => clock.sleep(5_000)
  await clock.advance(MINUTE + 5_000)
  w.answers = async () => {}
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(2)
})

test('a push after the watched pull request ended looks for the next one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()
  w.pull.state = 'MERGED'
  await clock.advance(MINUTE)
  expect(w.status).toBe('PR #7 マージ済み')

  // The session moves to another branch, whose pull request is open
  w.pull.state = 'OPEN'
  w.branchPr = { url: 'https://github.com/HolyGrail/claude-mods/pull/9', state: 'OPEN' }
  await $.tool.call({ tool: 'Bash', command: 'git push -u origin next' })
  await clock.settle()
  expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
})

test('the cleanup button comes back when its prompt does not enter', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    turnStarts: async () => {
      throw new Error('the queue is closed')
    },
  })
  await $.session.start(START)
  await clock.settle()
  w.pull.state = 'MERGED'
  await clock.advance(MINUTE)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'cleanup' })
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('/dev cleanup')])
  expect(await ui.find({ key: 'cleanup' })).toBeDefined()
})

test('a push still running when a poll sees its head already counts as the baseline', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  // The push takes over a minute, and GitHub has the new head before it returns
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(30_000)
    w.pull.head = 'b2'
    await clock.sleep(60_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  // Codex approved the previous push, and the reaction keeps that time
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(MINUTE + 30_000)
  await push
  expect(w.prompts).toEqual([])
})

test('a Codex review pushed off the newest page by later reviews is still found', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: {
      // The newest page is all other reviewers', still after the last push
      reviews: [{ id: 2, at: NOW - 2 * MINUTE, comments: 0, by: 'someone' }],
      olderReviews: [{ id: 1, at: NOW - 5 * MINUTE, comments: 4 }],
    },
  })
  await $.session.start(START)
  await clock.settle()

  expect(w.queries).toBe(2)
  expect(w.prompts).toEqual([expect.stringContaining('inline コメント 4 件')])
})

test('a pending review at the start of a page does not stop the search for older pages', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: {
      reviews: [
        { id: 3, at: 0, comments: 0, by: 'someone', pending: true },
        { id: 2, at: NOW - 2 * MINUTE, comments: 0, by: 'someone' },
      ],
      olderReviews: [{ id: 1, at: NOW - 5 * MINUTE, comments: 4 }],
    },
  })
  await $.session.start(START)
  await clock.settle()

  expect(w.prompts).toEqual([expect.stringContaining('inline コメント 4 件')])
})

test('nothing is relayed while a push runs, even before GitHub has its head', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  // The push takes over a minute, and GitHub has the new head only as it returns
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(90_000)
    w.pull.head = 'b2'
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  // Codex approved the previous push
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(90_000)
  await push
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
})

test('a push after the watched pull request ended is the baseline of the next one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  let pushed = ''
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()
  w.pull.state = 'MERGED'
  await clock.advance(MINUTE)

  // The next branch's pull request carries an approval from before this push
  pushed = '   a1a1a1a..b2b2b2b  next -> next\n'
  w.pull = { state: 'OPEN', head: 'b2b2b2b0123456789', branch: 'next', thumbsUpAt: NOW + 70_000 }
  w.branchPr = { url: 'https://github.com/HolyGrail/claude-mods/pull/9', state: 'OPEN' }
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push -u origin next' })
  await clock.settle()
  expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
  expect(w.prompts).toEqual([])
})

test('resuming another conversation watches its pull request instead', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  await clock.settle()
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認')

  w.devSessions['feature.json'] = devSession({ pr_url: 'https://github.com/HolyGrail/claude-mods/pull/9' })
  await $.classic.SessionStart({ source: 'resume' })
  await clock.settle()
  expect(w.status).toBe('PR #9 監視中 · 21:00 確認')
})

test('a session.start that finds no pull request clears the status line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認')

  w.devSessions = {}
  await $.session.start(START)
  await clock.settle()
  expect(w.status).toBeUndefined()
})

test('pages an earlier poll went through are not asked for again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: {
      reviews: [{ id: 2, at: NOW - 10 * MINUTE, comments: 0, by: 'someone' }],
      olderReviews: [{ id: 1, at: NOW - 20 * MINUTE, comments: 4 }],
    },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.queries).toBe(2)

  await clock.advance(MINUTE)
  expect(w.queries).toBe(3)
  expect(w.prompts.length).toBe(1)
})

test('what was relayed for an open pull request outlasts two weeks unwatched', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - 25 * MINUTE, comments: 2 }] } })
  w.store.set('pr:' + URL.toLowerCase(), { since: LAST_PUSH, head: 'a1', approvedAt: 0, usageLimitAt: 0, reviews: [1], ended: null, at: NOW - 20 * 24 * 60 * MINUTE })
  await $.session.start(START)
  await clock.settle()

  expect(w.prompts).toEqual([])
})

test('watching the next pull request takes the last one\'s cleanup button away', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()
  w.pull.state = 'MERGED'
  await clock.advance(MINUTE)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'cleanup' })).toBeDefined()
  w.pull.state = 'OPEN'
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: 'https://github.com/HolyGrail/claude-mods/pull/9' })
  await clock.settle()
  expect(await ui.find({ key: 'cleanup' })).toBeUndefined()
})

// This session's poll note on the pull request
const NOTE = 'poll:session-b:' + URL.toLowerCase()

// Another session's poll note, as that session writes it before asking GitHub
const pollNote = (at: number, pr = URL.toLowerCase()) => ({ pr, at })

test('a session that polls in the same round as an earlier one leaves the waking to it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  // The other session started its poll a moment earlier and has not written what it relayed yet
  w.store.set('poll:session-a', pollNote(NOW - 1_000))
  await $.session.start(START)
  await clock.settle()

  expect(w.prompts).toEqual([])
  // The record is left to the session that relays, so nothing is lost if that one never does
  expect(w.store.has('pr:' + URL.toLowerCase())).toBe(false)
})

test('a session whose poll started at the same moment yields only to a smaller key', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  w.store.set('poll:session-c', pollNote(NOW))
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts.length).toBe(1)
})

test('a session that polled earlier but stopped holds back no later round', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  // The other session went away before relaying
  w.store.set('poll:session-a', pollNote(NOW - 1_000))
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])

  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
})

test('a poll of another pull request holds nothing back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  w.store.set('poll:session-a', pollNote(NOW - 1_000, 'https://github.com/holygrail/claude-mods/pull/3'))
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts.length).toBe(1)
})

test('a push seen by a session that leaves the waking to another goes out in its note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // This session pushes; the other session, which did not see the push, polls just before it
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.pull.head = 'b2'
  w.store.set('poll:session-a', pollNote(NOW + MINUTE - 1_000))
  await clock.advance(40_000)
  expect(w.store.get(NOTE)).toEqual({ pr: URL.toLowerCase(), at: NOW + MINUTE, since: NOW + 20_000, deferred: true })
})

test('the session that relays takes the last push from the other sessions\' notes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // Codex approved before a push only another session saw, which polled in an earlier round
  const w = stubWorld(on, { pull: { thumbsUpAt: NOW - 5 * MINUTE } })
  w.store.set('poll:session-a', { ...pollNote(NOW - 40_000), since: NOW - 2 * MINUTE })
  await $.session.start(START)
  await clock.settle()

  expect(w.prompts).toEqual([])
  expect((w.store.get('pr:' + URL.toLowerCase()) as { since: number }).since).toBe(NOW - 2 * MINUTE)
})

test('a session that leaves the waking to another never writes over the record, even for a reopened pull request', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  // The copy both sessions read, before the leader cleared ended and marked the review
  const closed = { since: LAST_PUSH, head: 'a1', approvedAt: 0, usageLimitAt: 0, reviews: [], ended: 'CLOSED', at: NOW - MINUTE }
  w.store.set('pr:' + URL.toLowerCase(), closed)
  w.store.set('poll:session-a', pollNote(NOW - 1_000))
  await $.session.start(START)
  await clock.settle()

  expect(w.store.get('pr:' + URL.toLowerCase())).toEqual(closed)
  expect(w.prompts).toEqual([])
})

test('a tick that comes while a poll still waits on GitHub leaves that poll its note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { answers: () => clock.sleep(70_000) })
  await $.session.start(START)
  await clock.settle()

  await clock.advance(MINUTE)
  expect(w.queries).toBe(1)
  expect(w.store.get(NOTE)).toMatchObject({ at: NOW })
})

test('a poll that could not ask GitHub leaves its note idle, with the push it knows', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { queryError: 'HTTP 502' })
  await $.session.start(START)
  await clock.settle()
  expect(w.status).toBe('PR #7 確認失敗 21:00: HTTP 502')
  expect(w.store.get(NOTE)).toEqual({ pr: URL.toLowerCase(), at: NOW, since: LAST_PUSH, idle: true })
})

test('a session that ends leaves its poll note idle', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('session.end', () => ({ sessionId: 'session-b' }))
  await $.session.start(START)
  await clock.settle()
  expect(w.store.get(NOTE)).toMatchObject(pollNote(NOW))

  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-b', resume: { id: 'session-b' } })
  expect(w.store.get(NOTE)).toMatchObject({ idle: true })
})

test('a lookup that succeeds after failing clears the failure from the status line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {}, branchPr: 'error' })
  await $.session.start(START)
  await clock.settle()
  expect(w.status).toBe('PR 検索失敗 21:00: error connecting to api.github.com')

  w.branchPr = null
  await clock.advance(MINUTE)
  expect(w.status).toBeUndefined()
})

test('a session that leaves the waking to another and knows nothing new does not write the record', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  // What the other session wrote when it relayed the review, which this one may have read too early
  const relayed = { since: LAST_PUSH, head: 'a1', approvedAt: 0, usageLimitAt: 0, reviews: [1], ended: null, at: NOW - 1_000 }
  w.store.set('pr:' + URL.toLowerCase(), relayed)
  w.store.set('poll:session-a', pollNote(NOW - 1_000))
  await $.session.start(START)
  await clock.settle()

  expect(w.store.get('pr:' + URL.toLowerCase())).toEqual(relayed)
  expect(w.prompts).toEqual([])
})

test('a poll of another session still running past its round keeps holding back later ones', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  // The other session's query has been waiting on GitHub for over a minute
  w.store.set('poll:session-a', { ...pollNote(NOW - 70_000), since: 0, running: true })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])
})

test('a poll left running by a session that died holds nothing back for long', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  w.store.set('poll:session-a', { ...pollNote(NOW - 11 * MINUTE), since: 0, running: true })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts.length).toBe(1)
})

test('a poll note carries the push the session file records from the start', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { answers: () => clock.sleep(10_000) })
  await $.session.start(START)
  await clock.settle()
  // Still waiting on GitHub, so a session that relays meanwhile counts the push
  expect(w.store.get(NOTE)).toEqual({ pr: URL.toLowerCase(), at: NOW, since: LAST_PUSH, running: true })

  await clock.advance(10_000)
  expect(w.store.get(NOTE)).toEqual({ pr: URL.toLowerCase(), at: NOW, since: LAST_PUSH })
})

test('an idle note holds nothing back but its push still counts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // The other session's query failed a moment ago; only it knew of the push after the approval
  const w = stubWorld(on, { pull: { thumbsUpAt: NOW - 5 * MINUTE, reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  w.store.set('poll:session-a', { ...pollNote(NOW - 1_000), since: NOW - 2 * MINUTE, idle: true })
  await $.session.start(START)
  await clock.settle()

  // The review after the push is relayed; the approval before it is not
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
})

test('resuming another conversation mid-poll leaves the note idle rather than running', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { answers: () => clock.sleep(10_000) })
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  await clock.settle()
  expect(w.store.get(NOTE)).toMatchObject({ running: true })

  // The resumed conversation has no pull request to watch
  w.devSessions = {}
  await $.classic.SessionStart({ source: 'resume' })
  await clock.advance(10_000)
  expect(w.store.get(NOTE)).toEqual({ pr: URL.toLowerCase(), at: NOW, since: LAST_PUSH, idle: true })
})

test('turning to another pull request leaves the last one\'s note behind', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  const other = 'https://github.com/HolyGrail/claude-mods/pull/9'
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: other })
  await clock.settle()
  expect(w.store.get(NOTE)).toEqual({ pr: URL.toLowerCase(), at: NOW, since: LAST_PUSH, idle: true })
  expect(w.store.get('poll:session-b:' + other.toLowerCase())).toMatchObject({ pr: other.toLowerCase() })
})

test('a push another session ran counts once the head has moved past the one it saw', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // Codex approved the head before the other session's push, which GitHub now has
  const w = stubWorld(on, { pull: { head: 'b2', thumbsUpAt: NOW - 5 * MINUTE } })
  w.store.set('poll:session-a', { ...pollNote(NOW - 40_000), since: 0, pending: { at: NOW - 2 * MINUTE, head: 'a1' } })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])
})

test('a push another session ran that left the head where it was does not count', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1', thumbsUpAt: NOW - 5 * MINUTE } })
  w.store.set('poll:session-a', { ...pollNote(NOW - 40_000), since: 0, pending: { at: NOW - 2 * MINUTE, head: 'a1' } })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました')])
})

test('a poll note carries a push this session ran before GitHub has its head', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  // The next poll is still waiting on GitHub
  w.answers = () => clock.sleep(10_000)
  await clock.advance(40_000)
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW + 20_000, head: 'a1' }], running: true })
})

test('a poll note is timed when it goes out, not before a slow read of the session file', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  w.reads = () => clock.sleep(5_000)
  w.answers = () => clock.sleep(10_000)
  await clock.advance(MINUTE + 5_000)
  expect(w.store.get(NOTE)).toMatchObject({ at: NOW + MINUTE + 5_000, running: true })
})

test('a push started while a poll waits on GitHub goes into that poll\'s note at once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  w.answers = () => clock.sleep(30_000)
  await clock.advance(MINUTE)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW + MINUTE, head: 'a1' }], running: true })
})

test('turning to another pull request keeps the push the last one\'s note was handing on', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // GitHub has not shown the push's head when the session turns to another pull request
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: 'https://github.com/HolyGrail/claude-mods/pull/9' })
  await clock.settle()
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW + 20_000, head: 'a1' }], idle: true })
})

test('a push another session ran before it saw any head does not count', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1', thumbsUpAt: NOW - 5 * MINUTE } })
  // The other session pushed before its first poll, so it cannot tell whether the push moved anything
  w.store.set('poll:session-a', { ...pollNote(NOW - 40_000), since: 0, pending: { at: NOW - 2 * MINUTE, head: null } })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました')])
})

test('a merge seen by a session that leaves the waking to another is left to that one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { state: 'MERGED' } })
  w.store.set('poll:session-a', pollNote(NOW - 1_000))
  await $.session.start(START)
  await clock.settle()
  expect(w.toasts).toEqual([])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'cleanup' })).toBeUndefined()

  // The other session raised the toast and recorded the merge; this one learns it from the record
  w.store.set('pr:' + URL.toLowerCase(), { since: LAST_PUSH, head: null, approvedAt: 0, usageLimitAt: 0, reviews: [], ended: 'MERGED', at: NOW })
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual([])
  expect(w.status).toBe('PR #7 マージ済み')
  expect(await ui.find({ key: 'cleanup' })).toBeDefined()
  await clock.advance(5 * MINUTE)
  expect(w.queries).toBe(2)
})

test('a poll whose note cannot be written asks nothing and relays nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] }, noteError: 'disk full' })
  await $.session.start(START)
  await clock.settle()
  expect(w.queries).toBe(0)
  expect(w.prompts).toEqual([])
  expect(w.status).toContain('PR #7 確認失敗 21:00: poll note:')

  w.noteError = undefined
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
})

test('an old idle note is kept while it holds a push the record has not counted', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { thumbsUpAt: NOW - 5 * MINUTE } })
  w.store.set('pr:' + URL.toLowerCase(), { since: LAST_PUSH, head: null, approvedAt: 0, usageLimitAt: 0, reviews: [], ended: null, at: NOW - 2 * 60 * MINUTE })
  // Another session's query kept failing for hours; only it knew of the push after the approval
  w.store.set('poll:session-a', { ...pollNote(NOW - 2 * 60 * MINUTE), since: NOW - 2 * MINUTE, idle: true })
  // This session left another pull request's note behind in an earlier run
  const record9 = 'pr:' + PR9.toLowerCase()
  w.store.set(record9, { since: LAST_PUSH, head: null, approvedAt: 0, usageLimitAt: 0, reviews: [], ended: null, at: NOW - 2 * 60 * MINUTE })
  w.store.set(NOTE9, { ...pollNote(NOW - 2 * 60 * MINUTE, PR9.toLowerCase()), since: NOW - 2 * MINUTE, idle: true })
  await $.session.start(START)
  await clock.settle()

  expect(w.prompts).toEqual([])
  expect(w.store.has(NOTE9)).toBe(true)
  // Once the record counts the push, this session's note goes
  w.store.set(record9, { ...(w.store.get(record9) as object), since: NOW - MINUTE })
  await $.session.start(START)
  await clock.settle()
  expect(w.store.has(NOTE9)).toBe(false)
})

test('another session\'s note is pruned only once stale, since it may be rewritten meanwhile', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  w.store.set('poll:session-a', pollNote(NOW - 2 * 60 * MINUTE))
  w.store.set('poll:session-c', pollNote(NOW - 15 * 24 * 60 * MINUTE))
  await $.session.start(START)
  await clock.settle()
  expect(w.store.has('poll:session-a')).toBe(true)
  expect(w.store.has('poll:session-c')).toBe(false)
})

test('a poll that cannot list the other sessions\' notes relays nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  // Listed fine for the prune at startup, then not once the poll has asked GitHub
  w.answers = async () => {
    w.keysError = 'store busy'
  }
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])
  expect(w.status).toContain('PR #7 確認失敗 21:00: poll notes:')
  expect(w.store.get(NOTE)).toMatchObject({ idle: true })

  w.answers = async () => {}
  w.keysError = undefined
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
})

test('a push another session is still running holds back the relays until it finishes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1', thumbsUpAt: NOW - 5 * MINUTE } })
  w.store.set('poll:session-a', { ...pollNote(NOW - 40_000), since: 0, pending: { at: NOW - MINUTE, head: 'a1', running: true } })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])

  // It pushed nothing new after all
  w.store.set('poll:session-a', { ...pollNote(NOW - 40_000), since: 0, pending: { at: NOW - MINUTE, head: 'a1' } })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました')])
})

test('a push left running by a session that died holds nothing back for long', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1', thumbsUpAt: NOW - 5 * MINUTE } })
  w.store.set('poll:session-a', { ...pollNote(NOW - 40_000), since: 0, pending: { at: NOW - 11 * MINUTE, head: 'a1', running: true } })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました')])
})

test('a poll note says a push is running only until it finishes', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(20_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(10_000)
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW, head: 'a1', running: true }] })
  await clock.advance(10_000)
  await push
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW }] })
  expect((w.store.get(NOTE) as { pending: object[] }).pending[0]).not.toHaveProperty('running')
})

test('a push that finishes after its session\'s poll failed clears the push from the idle note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(90_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.queryError = 'HTTP 502'
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).toMatchObject({ idle: true, pending: [{ at: NOW, running: true }] })
  await clock.advance(30_000)
  await push
  expect(w.store.get(NOTE)).toMatchObject({ idle: true, pending: [{ at: NOW }] })
  expect((w.store.get(NOTE) as { pending: object[] }).pending[0]).not.toHaveProperty('running')
})

test('a poll cut short by a watch restarted at the same moment leaves the new poll running', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { answers: () => clock.sleep(10_000) })
  await $.session.start(START)
  await clock.settle()

  // The same pull request is watched again before the clock moves, and GitHub answers slower now
  w.answers = () => clock.sleep(60_000)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.advance(10_000)
  expect(w.queries).toBe(2)
  expect(w.store.get(NOTE)).toMatchObject({ at: NOW, running: true })
})

test('a poll overtaken by a new watch while it reads the session file writes no note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()
  expect(w.store.get(NOTE)).toEqual({ pr: URL.toLowerCase(), at: NOW, since: LAST_PUSH })

  w.reads = () => clock.sleep(5_000)
  await clock.advance(MINUTE)
  // The session turns to another pull request while the poll still reads the session file
  w.reads = async () => {}
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: 'https://github.com/HolyGrail/claude-mods/pull/9' })
  await clock.advance(10_000)
  expect(w.store.get(NOTE)).toMatchObject({ at: NOW })
  expect(w.store.get(NOTE)).not.toHaveProperty('running')
  expect(w.store.get('poll:session-b:https://github.com/holygrail/claude-mods/pull/9')).not.toHaveProperty('running')
})

test('a push that finishes after the session turned to another pull request clears it from the last one\'s note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(90_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(10_000)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: 'https://github.com/HolyGrail/claude-mods/pull/9' })
  await clock.advance(10_000)
  expect(w.store.get(NOTE)).toMatchObject({ idle: true, pending: [{ at: NOW, running: true }] })
  await clock.advance(70_000)
  await push
  expect(w.store.get(NOTE)).toMatchObject({ idle: true, pending: [{ at: NOW }] })
  expect((w.store.get(NOTE) as { pending: object[] }).pending[0]).not.toHaveProperty('running')
})

test('a push counts against the head before it even once another session recorded the new one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // Codex approved the previous push; after this push another session polls first and records b2
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.pull.head = 'b2'
  const record = w.store.get('pr:' + URL.toLowerCase()) as Record<string, unknown>
  w.store.set('pr:' + URL.toLowerCase(), { ...record, head: 'b2', at: NOW + 30_000 })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
})

test('a push of another branch does not move the baseline, even after the head moved some other way', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  const pushed = '   c3c3c3c..d4d4d4d  other -> other\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  // Someone else pushed b2 and Codex approved it; then this session pushes another branch
  w.pull.head = 'b2'
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin other' })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました')])
})

test('a push counts once GitHub shows the commit it pushed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  const pushed = '   a1a1a1a..b2b2b2b  feature -> feature\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.pull.head = 'b2b2b2b0123456789'
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ since: NOW + 20_000 })
})

test('a session that leaves the waking to another pages through the same pages again next time', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: {
      reviews: [{ id: 2, at: NOW - 10 * MINUTE, comments: 0, by: 'someone' }],
      olderReviews: [{ id: 1, at: NOW - 20 * MINUTE, comments: 4 }],
    },
  })
  // The other session was elected but never wrote what it relayed
  w.store.set('poll:session-a', pollNote(NOW - 1_000))
  await $.session.start(START)
  await clock.settle()
  expect(w.queries).toBe(2)
  expect(w.prompts).toEqual([])

  await clock.advance(MINUTE)
  expect(w.queries).toBe(4)
  expect(w.prompts).toEqual([expect.stringContaining('inline コメント 4 件')])
})

test('a push whose note cannot be written still runs, and says so in the status line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  let pushes = 0
  on('tool.call', { tool: 'Bash' }, () => {
    pushes += 1
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  w.noteError = 'disk full'
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  expect(pushes).toBe(1)
  expect(w.status).toContain('push note:')
})

test('a poll that left the round to another holds no later poll back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  // Sessions polling 20 s apart: the one just before this one yielded to the one before it
  w.store.set('poll:session-a', { ...pollNote(NOW - 20_000), deferred: true })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
})

test('a push compares against the head seen last, not the poll that started last', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // Another session's poll started earlier but saw b2 after this one saw a1; Codex approved b2
  w.pull.head = 'b2'
  w.pull.thumbsUpAt = NOW + 15_000
  const record = w.store.get('pr:' + URL.toLowerCase()) as Record<string, unknown>
  w.store.set('pr:' + URL.toLowerCase(), { ...record, head: 'b2', at: NOW - 5_000, headAt: NOW + 10_000 })
  // A push whose output names no commit, and which moves nothing
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push -q origin HEAD' })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました')])
})

test('a push that finishes after the session turned away hands its commits on, and retries a refused write', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  const pushed = '   a1a1a1a..b2b2b2b  feature -> feature\n'
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(90_000)
    return { result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed } as never
  })
  await $.session.start(START)
  await clock.settle()

  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(10_000)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: 'https://github.com/HolyGrail/claude-mods/pull/9' })
  await clock.advance(10_000)
  expect(w.store.get(NOTE)).toMatchObject({ idle: true, pending: [{ at: NOW, running: true }] })

  // The store refuses the write as the push finishes, and takes the next one
  w.noteError = 'busy'
  await clock.advance(70_000)
  await push
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ running: true }] })
  w.noteError = undefined
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).toMatchObject({ idle: true, pending: [{ at: NOW, shas: ['b2b2b2b'] }] })
  expect((w.store.get(NOTE) as { pending: object[] }).pending[0]).not.toHaveProperty('running')
})

test('two pushes run side by side each count for what they pushed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    const watchedBranch = (e as { command: string }).command.includes('feature')
    await clock.sleep(watchedBranch ? 30_000 : 10_000)
    const pushed = watchedBranch ? '   a1a1a1a..b2b2b2b  feature -> feature\n' : '   c3c3c3c..d4d4d4d  other -> other\n'
    return { result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed } as never
  })
  await $.session.start(START)
  await clock.settle()

  // Codex approved the previous push; the feature push starts first, the other one just after
  w.pull.thumbsUpAt = NOW + 5_000
  await clock.advance(10_000)
  const feature = $.tool.call({ tool: 'Bash', command: 'git push origin feature' })
  await clock.advance(1_000)
  const other = $.tool.call({ tool: 'Bash', command: 'git push origin other' })
  await clock.advance(30_000)
  await Promise.all([feature, other])
  w.pull.head = 'b2b2b2b0123456789'
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
})

const PR9 = 'https://github.com/HolyGrail/claude-mods/pull/9'
const NOTE9 = 'poll:session-b:' + PR9.toLowerCase()

test('a push that moves another ref to the head the pull request already had does not count', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'b2b2b2b0123456789' } })
  const pushed = '   c3c3c3c..b2b2b2b  HEAD -> other\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD:other' })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました')])
})

test('a quiet push made before any head was known does not move the baseline', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {} })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // The pull request already existed with Codex's approval of its head; the push changes nothing
  w.branchPr = { url: URL, state: 'OPEN' }
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push -q origin HEAD' })
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました')])
})

test('a note the store would not take as idle is written again on the next poll', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  // The session turns to another pull request mid-poll while the store refuses every note
  w.answers = () => clock.sleep(30_000)
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).toMatchObject({ running: true })
  w.noteError = 'busy'
  w.answers = async () => {}
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(1_000)
  expect(w.store.get(NOTE)).toMatchObject({ running: true })

  w.noteError = undefined
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).toMatchObject({ idle: true })
  expect(w.store.get(NOTE)).not.toHaveProperty('running')
})

test('a push belongs to the pull request watched as it starts, even if the watch turns while it looks up the head', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(20_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  w.gets = () => clock.sleep(5_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(1_000)
  const turned = $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(30_000)
  await Promise.all([push, turned])
  w.gets = async () => {}
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW }] })
  expect(w.store.get(NOTE9)).not.toHaveProperty('pending')
})

test('coming back to a pull request keeps the push its note was handing on', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  const pushed = '   a1a1a1a..b2b2b2b  feature -> feature\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  // GitHub has not shown the pushed commit yet when the session turns away and back
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.settle()
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW + 20_000, shas: ['b2b2b2b'] }] })
  expect(w.store.get(NOTE)).not.toHaveProperty('idle')
})

test('a push started before the pull request had a note keeps one when the watch turns away', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { reads: () => clock.sleep(10_000) })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  // The watch has begun, and its first poll still reads the session file
  await clock.advance(10_500)
  expect(w.store.has(NOTE)).toBe(false)

  w.gets = () => clock.sleep(5_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(1_000)
  const turned = $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(30_000)
  await Promise.all([push, turned])
  w.gets = async () => {}
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).toMatchObject({ idle: true, pending: [{ at: NOW + 10_500 }] })
})

test('a note write the store answers late does not land over a later one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(61_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(1_000)
  // The note the tick leaves after its query, saying the push runs, is slow to land; the one
  // saying it finished is not
  let writes = 0
  w.sets = async (key) => {
    if (key !== NOTE || ++writes !== 2) return
    await clock.sleep(5_000)
  }
  await clock.advance(70_000)
  await push
  await clock.settle()
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW }] })
  expect((w.store.get(NOTE) as { pending: object[] }).pending[0]).not.toHaveProperty('running')
})

test('pruning leaves a note its session wrote again while it was deciding', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  w.store.set('poll:session-a', pollNote(NOW - 2 * 60 * MINUTE))
  w.gets = async (key) => {
    if (key === 'poll:session-a') await clock.sleep(5_000)
  }
  const started = $.session.start(START)
  await clock.advance(2_000)
  // The other session polls again before the prune deletes its old note
  w.store.set('poll:session-a', pollNote(NOW + 2_000))
  await clock.advance(20_000)
  await started
  expect(w.store.get('poll:session-a')).toEqual(pollNote(NOW + 2_000))
})

test('watching the same pull request again keeps the push its note was handing on', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // Codex reviewed before the push only the session file records
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: LAST_PUSH - 2 * MINUTE, comments: 1 }] } })
  // This session's first poll leaves the round to another, so no record holds the push yet
  w.store.set('poll:session-a', pollNote(NOW - 1_000))
  await $.session.start(START)
  await clock.settle()
  expect(w.store.get(NOTE)).toMatchObject({ since: LAST_PUSH })

  // The session file cannot be read when the watch starts over
  w.devSessions = {}
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.store.get(NOTE)).toMatchObject({ since: LAST_PUSH })
})

test('turning to another pull request frees the last one\'s round at once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  // The next poll waits on GitHub, and the watch turns while it does
  w.answers = () => clock.sleep(5 * MINUTE)
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).toMatchObject({ running: true })
  w.reads = () => clock.sleep(20_000)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(1_000)
  expect(w.store.get(NOTE)).toMatchObject({ idle: true })
  expect(w.store.get(NOTE)).not.toHaveProperty('running')
})

test('a merge seen as the watch turns leaves the next pull request\'s baseline alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  // The record of the merged pull request knows of a later push, and is slow to read
  const record = 'pr:' + URL.toLowerCase()
  w.store.set(record, { ...(w.store.get(record) as object), since: NOW + 30_000 })
  w.pull.state = 'MERGED'
  w.gets = async (key) => {
    if (key === record) await clock.sleep(10_000)
  }
  await clock.advance(MINUTE + 1_000)
  w.gets = undefined
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(2 * MINUTE)
  expect(w.store.get(NOTE9)).toMatchObject({ pr: PR9.toLowerCase() })
  expect((w.store.get(NOTE9) as { since: number }).since).toBeLessThan(NOW + 30_000)
})

test('a poll whose query outlasted its turn relays nothing beside the one that took it over', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  w.answers = () => clock.sleep(11 * MINUTE)
  await $.session.start(START)
  // Another session stops waiting on this one and polls itself
  await clock.advance(10 * MINUTE + 30_000)
  w.store.set('poll:session-a', { ...pollNote(NOW + 10 * MINUTE + 30_000), running: true })
  await clock.advance(30_000)
  expect(w.prompts).toEqual([])
  expect(w.status).toContain('poll outlasted its turn')
})

test('a push whose record could not be read knows no head before it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // Another session saw the head move to b2, and Codex reviewed it
  const record = 'pr:' + URL.toLowerCase()
  w.store.set(record, { ...(w.store.get(record) as object), head: 'b2', headAt: NOW + 10_000 })
  w.pull.head = 'b2'
  w.pull.reviews = [{ id: 1, at: NOW + 20_000, comments: 1 }]
  await clock.advance(30_000)
  // A push that names no commit starts while the record cannot be read
  w.getFails = (key) => key === record
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.getFails = undefined
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
})

test('a poll whose record the store kept waiting past its turn relays nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  w.answers = () => clock.sleep(9 * MINUTE)
  on('session.end', () => ({ sessionId: 'session-b' }))
  await $.session.start(START)
  await clock.advance(1_000)
  // GitHub answers in time, then the record is slow to read
  w.gets = async (key) => {
    if (key.startsWith('pr:')) await clock.sleep(MINUTE)
  }
  await clock.advance(10 * MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.status).toContain('poll outlasted its turn')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-b', resume: { id: 'session-b' } })
  w.gets = undefined
  w.answers = async () => {}
  await clock.advance(10 * MINUTE)
})

test('a push started while the first poll reads the session file is seen running at once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { reads: () => clock.sleep(10_000) })
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(30_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.advance(10_500)
  expect(w.store.has(NOTE)).toBe(false)

  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(1_000)
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW + 10_500, running: true }] })
  await clock.advance(MINUTE)
  await push
})

test('a push whose run threw is no longer shown running', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => {
    throw new Error('runner gone')
  })
  await $.session.start(START)
  await clock.settle()

  await expect($.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })).rejects.toThrow()
  await clock.settle()
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW }] })
  expect((w.store.get(NOTE) as { pending: object[] }).pending[0]).not.toHaveProperty('running')
})

test('a merge seen as the watch turns leaves the next pull request\'s pushes alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pulls: { 9: { head: 'b2' } } })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // The merged pull request's record is slow to read while the watch turns and a push runs
  const record = 'pr:' + URL.toLowerCase()
  w.pull.state = 'MERGED'
  w.gets = async (key) => {
    if (key === record) await clock.sleep(10_000)
  }
  await clock.advance(MINUTE + 1_000)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(10_000)
  w.gets = undefined
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE9)).toMatchObject({ pending: [{ at: NOW + MINUTE + 2_000, head: 'b2' }] })
})

test('watching the same pull request again frees the round of the poll it stops', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  // The next poll waits on GitHub, and the watch starts over while it does
  w.answers = () => clock.sleep(5 * MINUTE)
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).toMatchObject({ running: true })
  w.reads = () => clock.sleep(20_000)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.advance(1_000)
  expect(w.store.get(NOTE)).toMatchObject({ idle: true, since: LAST_PUSH })
  expect(w.store.get(NOTE)).not.toHaveProperty('running')
  // The new poll takes up the baseline the note held
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).toMatchObject({ since: LAST_PUSH, running: true })
})

test('a merge seen as the watch turns leaves the next pull request\'s note running when it lapses', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  // The merged pull request's record is so slow to read that the poll lapses
  const record = 'pr:' + URL.toLowerCase()
  w.pull.state = 'MERGED'
  w.gets = async (key) => {
    if (key === record) await clock.sleep(10 * MINUTE)
  }
  await clock.advance(MINUTE + 1_000)
  // The next pull request's first poll waits on GitHub meanwhile
  w.pulls = { 9: {} }
  w.answers = () => clock.sleep(20 * MINUTE)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(11 * MINUTE)
  expect(w.store.get(NOTE9)).toMatchObject({ running: true })
  expect(w.status).not.toContain('poll outlasted its turn')
})

test('a merge seen as the watch turns keeps the next pull request\'s baseline out of its record', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  const record = 'pr:' + URL.toLowerCase()
  w.pull.state = 'MERGED'
  w.gets = async (key) => {
    if (key === record) await clock.sleep(10_000)
  }
  await clock.advance(MINUTE + 1_000)
  // The next pull request was pushed to later than anything the merged one knows
  w.pulls = { 9: {} }
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9, since: iso(NOW + 30_000) })
  await clock.advance(20_000)
  w.gets = undefined
  await clock.settle()
  expect((w.store.get(record) as { since: number; ended: string }).ended).toBe('MERGED')
  expect((w.store.get(record) as { since: number }).since).toBeLessThan(NOW + 30_000)
})

test('a poll note is timed once the session id is known', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  // The next poll waits on the session id while another session starts its poll and asks GitHub
  let slow = true
  w.ids = async () => {
    if (!slow) return
    slow = false
    await clock.sleep(20_000)
  }
  await clock.advance(MINUTE + 5_000)
  w.store.set('poll:session-a', pollNote(NOW + MINUTE + 5_000))
  await clock.advance(30_000)
  // That session started first, so it relays
  expect(w.prompts).toEqual([])
  expect(w.store.get(NOTE)).toMatchObject({ at: NOW + MINUTE + 20_000 })
})

test('a push goes out running before its head is looked up', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(30_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  // The record that holds the head is slow to read
  const record = 'pr:' + URL.toLowerCase()
  w.gets = async (key) => {
    if (key === record) await clock.sleep(10_000)
  }
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(1_000)
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW, running: true }] })
  await clock.advance(10_000)
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW, head: 'a1', running: true }] })
  w.gets = undefined
  await clock.advance(MINUTE)
  await push
})

test('a push still running for the last pull request holds back nothing for the next', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pulls: { 9: { reviews: [{ id: 5, at: NOW + 30_000, comments: 1 }] } } })
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(5 * MINUTE)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(1_000)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9, since: iso(NOW) })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
  await clock.advance(5 * MINUTE)
  await push
})

test('a push started while the record is written holds back what the poll was about to relay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(MINUTE)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  // The next poll finds a review, and its record is slow to land
  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  const record = 'pr:' + URL.toLowerCase()
  w.sets = async (key) => {
    if (key === record) await clock.sleep(10_000)
  }
  await clock.advance(MINUTE + 1_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(15_000)
  expect(w.prompts).toEqual([])
  w.sets = undefined
  await clock.advance(MINUTE)
  await push
})

test('a push before the first note goes out without waiting on the session id', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { reads: () => clock.sleep(10_000) })
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(30_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.advance(10_500)
  expect(w.store.has(NOTE)).toBe(false)

  // Asking for the id now would keep the push from the other sessions for a while
  w.ids = () => clock.sleep(20_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(1_000)
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW + 10_500, running: true }] })
  w.ids = undefined
  await clock.advance(MINUTE)
  await push
})

test('a push that started and finished while the record was written still holds back the relay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  const record = 'pr:' + URL.toLowerCase()
  w.sets = async (key) => {
    if (key === record) await clock.sleep(10_000)
  }
  await clock.advance(MINUTE + 1_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(15_000)
  expect(w.prompts).toEqual([])
  w.sets = undefined
})

test('a record write that lands past the lease sends nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  on('session.end', () => ({ sessionId: 'session-b' }))
  w.answers = () => clock.sleep(9 * MINUTE)
  await $.session.start(START)
  await clock.advance(1_000)
  // GitHub answers in time, and the record is slow to land
  w.sets = async (key) => {
    if (key.startsWith('pr:')) await clock.sleep(MINUTE)
  }
  await clock.advance(10 * MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.status).toContain('poll outlasted its turn')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-b', resume: { id: 'session-b' } })
  w.sets = undefined
  w.answers = async () => {}
  await clock.advance(10 * MINUTE)
})

test('a poll yields to a note written while its own was on its way', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  // The next poll's note is slow to land, and another session starts its poll meanwhile
  let writes = 0
  w.sets = async (key) => {
    if (key === NOTE && ++writes === 1) await clock.sleep(20_000)
  }
  await clock.advance(MINUTE + 5_000)
  w.store.set('poll:session-a', pollNote(NOW + MINUTE + 5_000))
  await clock.advance(20_000)
  expect(w.prompts).toEqual([])
})

test('a push started as the watch turns stays with the pull request watched as it started', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(20_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  const turned = $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(30_000)
  await Promise.all([push, turned])
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW }] })
  expect(w.store.get(NOTE9)).not.toHaveProperty('pending')
})

test('a push made after a resume, before the first poll, goes under the resumed conversation\'s id', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('classic.SessionStart', () => ({}))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // The resumed conversation's id is slow to come
  w.sessionId = 'session-c'
  w.devSessions = {}
  w.ids = () => clock.sleep(10_000)
  await $.classic.SessionStart({ source: 'resume' })
  const turned = $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(1_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(MINUTE)
  await Promise.all([turned, push])
  expect(w.store.has(NOTE9)).toBe(false)
  expect(w.store.get('poll:session-c:' + PR9.toLowerCase())).toMatchObject({ pending: [{ at: NOW + 1_000 }] })
  w.ids = undefined
})

test('a push another session started while the record was written holds back the relay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  const record = 'pr:' + URL.toLowerCase()
  w.sets = async (key) => {
    if (key === record) await clock.sleep(10_000)
  }
  await clock.advance(MINUTE + 1_000)
  // The other session's push note lands after this poll read the notes
  w.store.set('poll:session-a:' + URL.toLowerCase(), {
    ...pollNote(NOW + MINUTE + 1_000),
    idle: true,
    pending: [{ at: NOW + MINUTE + 1_000, head: null, running: true }],
  })
  await clock.advance(15_000)
  expect(w.prompts).toEqual([])
  w.sets = undefined
})

test('a baseline another session\'s note shows once the record is written holds back the relay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  const record = 'pr:' + URL.toLowerCase()
  w.sets = async (key) => {
    if (key === record) await clock.sleep(10_000)
  }
  await clock.advance(MINUTE + 1_000)
  // The other session read a newer push from its session file after this poll read the notes
  w.store.set('poll:session-a:' + URL.toLowerCase(), { ...pollNote(NOW + MINUTE + 1_000), idle: true, since: NOW + 40_000 })
  await clock.advance(15_000)
  expect(w.prompts).toEqual([])
  w.sets = undefined
})

test('the head is timed when GitHub showed it, not once the older pages came', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let asked = 0
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 2, at: NOW - 2 * MINUTE, comments: 0, by: 'someone' }], olderReviews: [] },
    answers: async () => {
      if (++asked === 2) await clock.sleep(20_000)
    },
  })
  await $.session.start(START)
  await clock.advance(30_000)
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ headAt: NOW })
})

test('a module started afresh for the same session keeps what its note in the store held', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - 20_000, comments: 1 }] } })
  // The module before the respawn knew of a push the record has not counted yet
  w.store.set(NOTE, { ...pollNote(NOW - 2 * MINUTE), idle: true, since: NOW - 10_000 })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ since: NOW - 10_000 })
})

test('a final read of the notes that outlasts the lease sends nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  on('session.end', () => ({ sessionId: 'session-b' }))
  const other = 'poll:session-a:' + URL.toLowerCase()
  w.store.set(other, { ...pollNote(NOW - 5 * MINUTE), idle: true })
  // Once the record is written, the store keeps the next read of the other note waiting
  let slow = false
  w.sets = async (key) => {
    if (key.startsWith('pr:')) slow = true
  }
  w.gets = async (key) => {
    if (slow && key === other) {
      slow = false
      await clock.sleep(9 * MINUTE + 30_000)
    }
  }
  await $.session.start(START)
  await clock.advance(9 * MINUTE + 31_000)
  expect(w.prompts).toEqual([])
  expect(w.status).toContain('poll outlasted its turn')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-b', resume: { id: 'session-b' } })
  w.sets = undefined
  w.gets = undefined
})

test('a push of another branch to the head does not count when no head was known before it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {} })
  const pushed = '   a1a1a1a..b2b2b2b  other -> other\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  // The pull request's own branch is at the same commit already, and Codex approved it
  w.branchPr = { url: URL, state: 'OPEN' }
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin other' })
  w.pull.head = 'b2b2b2b0123456789'
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('approved')])
})

test('pruning leaves this session\'s note a watch took up while it was deciding', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {} })
  const record = 'pr:' + URL.toLowerCase()
  w.store.set(NOTE, { ...pollNote(NOW - 2 * 60 * MINUTE), idle: true, since: LAST_PUSH })
  w.store.set(record, { at: NOW - MINUTE, since: LAST_PUSH })
  w.gets = async (key) => {
    if (key === record) await clock.sleep(5_000)
  }
  const started = $.session.start(START)
  await clock.advance(1_000)
  // The pull request is watched while the prune still reads the record
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.advance(1_000)
  w.gets = undefined
  await clock.advance(20_000)
  await started
  expect(w.deleted).not.toContain(NOTE)
  expect(w.store.has(NOTE)).toBe(true)
})

test('a push still pending for a pull request that ended stays out of the next one', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // A quiet push leaves the head where it was, so it never counts, and the pull request is merged
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.pull.state = 'MERGED'
  await clock.advance(MINUTE)

  // The next pull request was approved before that push, at a head of its own
  w.pulls = { 9: { head: 'c3c3c3c', branch: 'next', thumbsUpAt: NOW + 10_000 } }
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('approved')])
})

test('a module started afresh keeps every push its note held, even two started at the same moment', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'b2b2b2b0123456789', reviews: [{ id: 1, at: NOW - 20_000, comments: 1 }] } })
  // One push moved another branch, the other the pull request's own, in the same millisecond
  w.store.set(NOTE, {
    ...pollNote(NOW - 2 * MINUTE),
    idle: true,
    since: LAST_PUSH,
    pending: [
      { id: 'p1', at: NOW - 10_000, head: 'a1', shas: ['d4d4d4d'], refs: { other: 'd4d4d4d' } },
      { id: 'p2', at: NOW - 10_000, head: 'a1', shas: ['b2b2b2b'], refs: { feature: 'b2b2b2b' } },
    ],
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])
})

test('a push whose Bash call hangs holds back this session\'s relays only as long as another session\'s', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(30 * MINUTE)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.pull.reviews = [{ id: 1, at: NOW + MINUTE, comments: 1 }]
  await clock.advance(5 * MINUTE)
  expect(w.prompts).toEqual([])
  await clock.advance(7 * MINUTE)
  expect(w.prompts.length).toBe(1)
  await clock.advance(20 * MINUTE)
  await push
})

test('a push made while none was watched stays with the pull request that took it up', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { devSessions: {} })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // A quiet push with no head known stays pending for the pull request found after it
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.branchPr = { url: URL, state: 'OPEN' }
  await clock.advance(2 * MINUTE)

  // The next pull request was approved before that push, and its head has moved since another
  // session last saw it
  w.store.set('pr:' + PR9.toLowerCase(), { at: NOW - MINUTE, since: 0, head: 'c3c3c3c' })
  w.pulls = { 9: { head: 'd4d4d4d', branch: 'next', thumbsUpAt: NOW + 10_000 } }
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('approved')])
})

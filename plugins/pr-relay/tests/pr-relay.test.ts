import { expect, mock, test } from 'claude-code/testing'
import type { ProcessRunInit } from 'claude-code'

const MINUTE = 60_000
const NOW = Date.UTC(2026, 9, 1, 12)
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

const URL = 'https://github.com/HolyGrail/claude-mods/pull/7'
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

const START = { surface: 'terminal', isInteractive: true, cwd: '/repo' } as const

// The stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

type Review = {
  id: number | null
  fullDatabaseId?: string | null
  nodeId?: string
  at: number
  comments: number
  by?: string
  pending?: true
  body?: string
  url?: string
  detailsTotal?: number
  details?: {
    id: number | null
    fullDatabaseId?: string | null
    path: string
    line: number | null
    originalLine?: number | null
    body: string
    url?: string
    outdated?: boolean
    replyTo?: { id: string } | null
    subjectType?: 'FILE' | 'LINE'
  }[]
}

type Pull = {
  state?: 'OPEN' | 'MERGED' | 'CLOSED'
  head?: string
  // The pull request's branch
  branch?: string
  // The branch it merges into
  base?: string
  committedAt?: number
  thumbsUpAt?: number
  reviews?: Review[]
  // Reviews on the page before the newest, which gh hands out for the cursor 'older'
  olderReviews?: Review[]
  comments?: { at: number; body: string }[]
}

const reviewNodes = (reviews: NonNullable<Pull['reviews']>) =>
  reviews.map((r) => ({
    id: r.nodeId ?? `review-${r.fullDatabaseId ?? r.id}`,
    databaseId: r.id,
    fullDatabaseId: r.fullDatabaseId,
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
    baseRefName: pull.base ?? 'main',
    commits: { nodes: [{ commit: { committedDate: iso(pull.committedAt ?? LAST_PUSH) } }] },
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

function reviewDetails(pulls: Pull[], ids: string[]) {
  const reviews = pulls.flatMap((p) => [...(p.reviews ?? []), ...(p.olderReviews ?? [])])
  const nodes = ids.map((id) => {
    const review = reviews.find((r) => (r.nodeId ?? `review-${r.fullDatabaseId ?? r.id}`) === id)
    if (!review) return null
    const comments: NonNullable<Review['details']> = review.details ?? Array.from({ length: Math.min(100, review.comments) }, (_, i) => ({
      id: (review.id ?? 0) * 1_000 + i + 1,
      path: `src/file-${i + 1}.ts`,
      line: i + 1,
      body: `Comment ${i + 1}`,
    }))
    return {
      databaseId: review.id,
      fullDatabaseId: review.fullDatabaseId,
      url: review.url ?? `${URL}#pullrequestreview-${review.fullDatabaseId ?? review.id}`,
      submittedAt: iso(review.at),
      commit: { oid: 'a1' },
      body: review.body ?? 'Review summary',
      comments: {
        totalCount: review.detailsTotal ?? review.comments,
        nodes: comments.map((c) => ({
          databaseId: c.id,
          fullDatabaseId: c.fullDatabaseId,
          path: c.path,
          line: c.line,
          originalLine: c.originalLine ?? c.line,
          body: c.body,
          url: c.url ?? `${URL}#discussion_r${c.fullDatabaseId ?? c.id}`,
          outdated: c.outdated ?? false,
          replyTo: c.replyTo ?? null,
          subjectType: c.subjectType ?? 'LINE',
        })),
      },
    }
  })
  return JSON.stringify({ data: { nodes } })
}

type World = {
  pull: Pull
  // The app's cached primary and other bound pull requests, with no desktop tool by default
  desktop?: {
    primary?: { number: number; state?: string }
    monitor?: { auto_fix?: boolean }
    others?: { number: number; state?: string }[]
  } | 'error' | 'deny'
  desktopAvailable?: boolean
  desktopResponse?: string
  desktopThrows?: boolean
  desktopAnswers?: () => Promise<void>
  toolListError?: boolean
  toolLists: number
  desktopCalls: number
  branchLookups: number
  processRuns: { argv: readonly string[]; init?: ProcessRunInit }[]
  // What gh pr view answers for the branch, null when it has no pull request, or 'error' when gh fails
  branchPr: { url: string; state: string } | null | 'error'
  // What a submitted prompt waits for before its turn starts
  turnStarts: () => Promise<void>
  dropPrompt?: boolean
  noticeError?: string
  // What gh api graphql waits for before it answers
  answers: () => Promise<void>
  // What gh api graphql fails with, when it does
  queryError?: string
  // Review details are fetched separately from the polling queries.
  detailsError?: string
  detailsResponse?: string
  detailsAnswer?: () => Promise<void>
  detailsArgv: (readonly string[])[]
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
  // The argument vectors of the polling gh api calls
  queryArgv: (readonly string[])[]
  store: Map<string, unknown>
  // The keys deleted from the store, in order
  deleted: string[]
  prompts: string[]
  toasts: string[]
  // The origin remote of the session's repository; null outside one
  remote: string | null
  // The arguments of the /notice runs pr-relay asked for
  posts: string[]
  // Stands for a session without notice-board, where /notice is unknown
  postError?: string
  status: string | undefined
  queries: number
  sessionId: string
}

function stubWorld(on: On, world: Partial<World> = {}): World {
  const w: World = {
    pull: {},
    branchPr: { url: URL, state: 'OPEN' },
    store: new Map(),
    deleted: [],
    prompts: [],
    toasts: [],
    remote: 'git@github.com:HolyGrail/claude-mods.git',
    posts: [],
    status: undefined,
    queries: 0,
    toolLists: 0,
    desktopCalls: 0,
    branchLookups: 0,
    processRuns: [],
    sessionId: 'session-b',
    queryArgv: [],
    detailsArgv: [],
    turnStarts: async () => {},
    answers: async () => {},
    ...world,
  }
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.id', async () => {
    await w.ids?.()
    return { value: w.sessionId }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__pr-relay__${e.name}` } }))
  on('tool.list', () => {
    w.toolLists += 1
    if (w.toolListError) throw new Error('tool list unavailable')
    return { value: [
      { name: 'Bash', description: 'Runs commands', mcp: false },
      ...(w.desktopAvailable ?? w.desktop !== undefined
        ? [{ name: 'mcp__ccd_pr__get_status', description: 'Reads bound pull requests', mcp: true }]
        : []),
    ] }
  })
  on('tool.call', { tool: 'mcp__ccd_pr__get_status' }, async () => {
    w.desktopCalls += 1
    const desktop = w.desktop
    const text = w.desktopResponse ?? JSON.stringify({
      bound: typeof desktop === 'object' && Boolean(desktop.primary || desktop.others?.length),
      pr: typeof desktop === 'object' && desktop.primary ? {
        ...desktop.primary,
        url: `https://github.com/HolyGrail/claude-mods/pull/${desktop.primary.number}`,
        repo: 'HolyGrail/claude-mods',
        host: 'github.com',
      } : undefined,
      monitor: typeof desktop === 'object' ? desktop.monitor : undefined,
      otherBoundPrs: typeof desktop === 'object' ? desktop.others?.map((pr) => ({ ...pr, repo: 'HolyGrail/claude-mods' })) : undefined,
    })
    await w.desktopAnswers?.()
    if (w.desktopThrows) throw new Error('tool unavailable or aborted')
    if (desktop === 'deny') return { deny: 'permission denied' }
    if (desktop === 'error') return { result: 'desktop unavailable', text: 'desktop unavailable', isError: true }
    return { result: text, text }
  })
  on('process.run', async ($, e) => {
    w.processRuns.push({ argv: e.argv, init: e.init })
    const run = (exitCode: number, stdout: string, stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (e.argv[1] === 'pr') {
      w.branchLookups += 1
      if (w.branchPr === 'error') return run(1, '', 'error connecting to api.github.com')
      return w.branchPr ? run(0, JSON.stringify(w.branchPr)) : run(1, '', 'no pull requests found for branch "feature"')
    }
    if (e.argv.some((arg) => arg.startsWith('query=') && arg.includes('nodes(ids:'))) {
      w.detailsArgv.push(e.argv)
      await w.detailsAnswer?.()
      if (w.detailsError) return run(1, '', w.detailsError)
      const ids = e.argv.filter((arg) => arg.startsWith('ids[]=')).map((arg) => arg.slice('ids[]='.length))
      return run(0, w.detailsResponse ?? reviewDetails([w.pull, ...Object.values(w.pulls ?? {})], ids))
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
    // Host notices pass through without counting as prompts sent by pr-relay
    if (e.origin.kind !== 'plugin') {
      if (w.noticeError) throw new Error(w.noticeError)
      return w.dropPrompt ? { drop: 'the queue is closed' } : { text: e.text, origin: e.origin }
    }
    w.prompts.push(e.text)
    await w.turnStarts()
    return w.dropPrompt ? { drop: 'the queue is closed' } : { text: e.text }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.repo', () => ({
    value: w.remote === null ? null : { root: '/repo', remote: w.remote, internal: false, name: null },
  }))
  on('command.run', ($, e) => {
    if (w.postError) throw new Error(w.postError)
    w.posts.push(`/${e.command} ${e.args}`)
    return { text: 'Posted.' }
  })
  on('ui.status', ($, e) => {
    w.status = e.text
    return { value: undefined }
  })
  // What the mods after this one draw in the band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by another mod'] }))
  return w
}

// The monitor identifies its pull request before quoting any GitHub comments
function monitorNotice(number = 7) {
  return `<ci-monitor-event>\n"Auto-fix pull requests" is watching HolyGrail/claude-mods PR #${number} and detected the following.\n\n` +
    'Review comment: quoted GitHub text\n</ci-monitor-event>'
}

// An approval that follows fresh monitored reviews points to the monitor's findings
const MONITORED_APPROVAL_NOTE = 'なお、この 👍 の前に Codex のレビューが付いています。指摘は Desktop の CI モニターから届きます。指摘に対応して push しない場合は、approved とみなしてかまいません。'

test('an auto-fix primary marks reviews without fetching details or prompting and shows the monitor', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } },
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 2 }] },
  })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  expect(w.prompts).toEqual([])
  expect(w.detailsArgv).toEqual([])
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'] })
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認 · CI モニター併用')
})

test('turning off auto-fix relays the next review without resending silently marked reviews', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } },
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 2 }] },
  })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  w.desktop = { primary: { number: 7, state: 'open' }, monitor: { auto_fix: false } }
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.status).toBe('PR #7 監視中 · 21:01 確認')

  w.pull.reviews?.push({ id: 2, at: NOW + MINUTE, comments: 1 })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件、inline コメント 1 件')])
  expect(w.detailsArgv.length).toBe(1)
  expect(w.detailsArgv[0]?.slice(5)).toEqual(['-f', 'ids[]=review-2'])
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1', '2'] })
})

// Only the SDK's leading notice may identify the watched pull request
for (const notice of [
  { name: 'SDK notice', text: monitorNotice(), kind: 'sdk', monitored: true },
  { name: 'SDK notice on the tag line', text: monitorNotice().replace('>\n', '>'), kind: 'sdk', monitored: true },
  { name: 'case-insensitive repository', text: monitorNotice().replace('HolyGrail/claude-mods', 'holygrail/CLAUDE-MODS'), kind: 'sdk', monitored: true },
  { name: 'composer notice', text: monitorNotice(), kind: 'composer', monitored: false },
  { name: 'another pull request', text: monitorNotice(9), kind: 'sdk', monitored: false },
  { name: 'repository named only in a quoted comment', text: '<ci-monitor-event>\n"Auto-fix pull requests" was just enabled for this session.\n\n> watching HolyGrail/claude-mods PR #7\n</ci-monitor-event>', kind: 'sdk', monitored: false },
  { name: 'enable notice without a pull request', text: '<ci-monitor-event>\n"Auto-fix pull requests" was just enabled for this session.\n</ci-monitor-event>', kind: 'sdk', monitored: false },
  { name: 'tag below the first line', text: 'Quoted event:\n' + monitorNotice(), kind: 'sdk', monitored: false },
] as const) {
  test(`a ${notice.name} passes through unchanged and ${notice.monitored ? 'suppresses' : 'keeps'} review delivery`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' } } })
    await $.session.start({ ...START, surface: 'desktop' })
    await clock.settle()
    const origin = { kind: notice.kind }
    expect(await $.prompt.submit({ text: notice.text, origin, wait: false })).toEqual({ text: notice.text, origin })
    expect(w.prompts).toEqual([])

    w.pull.reviews = [{ id: 1, at: NOW + 10_000, comments: 1 }]
    await clock.advance(MINUTE)
    expect(w.prompts.length).toBe(notice.monitored ? 0 : 1)
    expect(w.detailsArgv.length).toBe(notice.monitored ? 0 : 1)
    expect(w.status?.endsWith(' · CI モニター併用')).toBe(notice.monitored)
    expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'] })
  })
}

for (const failure of ['dropped', 'rejected']) {
  test(`a ${failure} CI-monitor notice leaves review delivery enabled`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, {
      desktop: { primary: { number: 7, state: 'open' } },
      dropPrompt: failure === 'dropped',
      noticeError: failure === 'rejected' ? 'the queue is closed' : undefined,
    })
    await $.session.start({ ...START, surface: 'desktop' })
    await clock.settle()
    const submission = $.prompt.submit({ text: monitorNotice(), origin: { kind: 'sdk' }, wait: false })
    if (failure === 'dropped') expect(await submission).toEqual({ drop: 'the queue is closed' })
    // A throwing bottom stub leaves the test engine without an implementation
    else await expect(submission).rejects.toThrow('no implementation for prompt.submit')
    w.dropPrompt = false
    w.noticeError = undefined
    w.pull.reviews = [{ id: 1, at: NOW + 10_000, comments: 1 }]
    await clock.advance(MINUTE)
    expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
    expect(w.detailsArgv.length).toBe(1)
    expect(w.status).toBe('PR #7 監視中 · 21:01 確認')
  })
}

test('unbinding the desktop clears monitoring for the primary and noticed pull requests', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } } })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  await $.prompt.submit({ text: monitorNotice(9), origin: { kind: 'sdk' }, wait: false })
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認 · CI モニター併用')

  w.desktop = {}
  w.pull.reviews = [{ id: 1, at: NOW + 10_000, comments: 1 }]
  w.answers = () => clock.sleep(10_000)
  await clock.advance(MINUTE)
  // The desktop read clears the status suffix even while the GitHub poll is still pending
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認')
  await clock.advance(10_000)
  expect(w.prompts).toEqual([expect.stringContaining('PR #7')])
  w.answers = async () => {}
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('PR #7'), expect.stringContaining('PR #9')])
  expect(w.detailsArgv.length).toBe(2)
  expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
})

test('a noticed secondary removed from the desktop binding list relays new reviews again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const secondary: Pull = {}
  const w = stubWorld(on, {
    desktop: {
      primary: { number: 7, state: 'open' },
      monitor: { auto_fix: true },
      others: [{ number: 9, state: 'open' }, { number: 10, state: 'open' }],
    },
    pulls: { 9: secondary },
  })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  await $.prompt.submit({ text: monitorNotice(9), origin: { kind: 'sdk' }, wait: false })
  await $.prompt.submit({ text: monitorNotice(10), origin: { kind: 'sdk' }, wait: false })
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  secondary.reviews = [{ id: 1, at: NOW + 10_000, comments: 1 }]
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.status).toBe('PR #9 監視中 · 21:01 確認 · CI モニター併用')

  w.desktop = {
    primary: { number: 7, state: 'open' },
    monitor: { auto_fix: true },
    others: [{ number: 10, state: 'open' }],
  }
  w.answers = () => clock.sleep(10_000)
  await clock.advance(MINUTE)
  // Losing the binding updates the status before the pending GitHub poll finishes
  expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
  await clock.advance(10_000)
  w.answers = async () => {}
  secondary.reviews.push({ id: 2, at: NOW + 2 * MINUTE + 20_000, comments: 1 })
  await clock.advance(MINUTE - 10_000)
  expect(w.prompts).toEqual([expect.stringContaining(`PR #9 (${PR9}) にレビューを付けました（レビュー 1 件`)])
  expect(w.detailsArgv.length).toBe(1)
  expect(w.detailsArgv[0]?.slice(5)).toEqual(['-f', 'ids[]=review-2'])
  expect(w.store.get('pr:' + PR9.toLowerCase())).toMatchObject({ reviews: ['1', '2'] })
  expect(w.status).toBe('PR #9 監視中 · 21:03 確認')

  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.settle()
  expect(w.status).toBe('PR #7 監視中 · 21:03 確認 · CI モニター併用')
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL.replace('/7', '/10') })
  await clock.settle()
  expect(w.status).toBe('PR #10 監視中 · 21:03 確認 · CI モニター併用')
})

test('a primary auto-fix flag overrides a monitor notice on the next read', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: false } } })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  await $.prompt.submit({ text: monitorNotice(), origin: { kind: 'sdk' }, wait: false })
  await clock.advance(MINUTE)
  w.pull.reviews = [{ id: 1, at: NOW + MINUTE, comments: 1 }]
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
  expect(w.status).toBe('PR #7 監視中 · 21:02 確認')
})

test('a noticed non-primary stays monitored across watch changes and absent desktop entries', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: false } } })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  await $.prompt.submit({ text: monitorNotice(9), origin: { kind: 'sdk' }, wait: false })
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  w.pull.reviews = [{ id: 1, at: NOW + 10_000, comments: 1 }]
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
  w.desktopResponse = '{}'
  await clock.advance(MINUTE)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.settle()
  w.pull.reviews = [{ id: 2, at: NOW + 2 * MINUTE, comments: 1 }]
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  expect(w.prompts.length).toBe(1)
  expect(w.store.get('pr:' + PR9.toLowerCase())).toMatchObject({ reviews: ['1', '2'] })
  expect(w.status).toBe('PR #9 監視中 · 21:02 確認 · CI モニター併用')
})

// Every conversation reset forgets notices even when the same pull request is found again
for (const source of ['start', 'resume', 'clear', 'fork'] as const) {
  test(`${source} forgets which pull requests the CI monitor watched`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' } } })
    on('classic.SessionStart', () => ({}))
    await $.session.start({ ...START, surface: 'desktop' })
    await clock.settle()
    await $.prompt.submit({ text: monitorNotice(), origin: { kind: 'sdk' }, wait: false })
    w.pull.reviews = [{ id: 1, at: NOW + 10_000, comments: 1 }]
    await clock.advance(MINUTE)
    expect(w.prompts).toEqual([])

    if (source === 'start') await $.session.start({ ...START, surface: 'desktop' })
    else await $.classic.SessionStart({ source })
    await clock.settle()
    w.pull.reviews?.push({ id: 2, at: NOW + MINUTE, comments: 1 })
    await clock.advance(MINUTE)
    expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
    expect(w.status).toBe('PR #7 監視中 · 21:02 確認')
  })
}

test('a monitored review followed by a thumbs-up sends only an approval with the monitor note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } },
    pull: { thumbsUpAt: NOW - MINUTE, reviews: [{ id: 1, at: NOW - 2 * MINUTE, comments: 1 }] },
  })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  expect(w.prompts).toEqual([
    `Codex が PR #7 (${URL}) を approved にしました（20:59）。CI の結果を確かめ、問題がなければ作業の完了を報告してください。\n` + MONITORED_APPROVAL_NOTE,
  ])
  expect(w.detailsArgv).toEqual([])
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'], approvedAt: NOW - MINUTE })
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
})

for (const autoFix of [false, true]) {
  test(`an approval comment ${autoFix ? 'is left to the monitor and stays marked after auto-fix is disabled' : 'still prompts without auto-fix'}`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, {
      desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: autoFix } },
      pull: { comments: [{ at: NOW - MINUTE, body: 'Didn\'t find any major issues' }] },
    })
    await $.session.start({ ...START, surface: 'desktop' })
    await clock.settle()
    expect(w.prompts).toEqual(autoFix ? [] : [
      `Codex が PR #7 (${URL}) を approved にしました（20:59）。CI の結果を確かめ、問題がなければ作業の完了を報告してください。`,
    ])
    expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ approvedAt: NOW - MINUTE })
    w.desktop = { primary: { number: 7, state: 'open' }, monitor: { auto_fix: false } }
    await clock.advance(2 * MINUTE)
    expect(w.prompts.length).toBe(autoFix ? 0 : 1)
  })
}

for (const commentAt of [NOW - 2 * MINUTE, NOW]) {
  test(`a monitored thumbs-up keeps its own timestamp beside an approval comment ${commentAt === NOW ? 'after' : 'before'} it`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, {
      desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } },
      pull: { thumbsUpAt: NOW - MINUTE, comments: [{ at: commentAt, body: 'Didn\'t find any major issues' }] },
    })
    await $.session.start({ ...START, surface: 'desktop' })
    await clock.settle()
    expect(w.prompts).toEqual([
      `Codex が PR #7 (${URL}) を approved にしました（20:59）。CI の結果を確かめ、問題がなければ作業の完了を報告してください。`,
    ])
    expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ approvedAt: Math.max(NOW - MINUTE, commentAt) })
    w.desktop = { primary: { number: 7, state: 'open' }, monitor: { auto_fix: false } }
    await clock.advance(2 * MINUTE)
    expect(w.prompts.length).toBe(1)
  })
}

test('a monitored review supersedes an earlier thumbs-up even when an approval comment comes later', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } },
    pull: {
      thumbsUpAt: NOW - 3 * MINUTE,
      reviews: [{ id: 1, at: NOW - 2 * MINUTE, comments: 1 }],
      comments: [{ at: NOW - MINUTE, body: 'Didn\'t find any major issues' }],
    },
  })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  expect(w.prompts).toEqual([])
  expect(w.detailsArgv).toEqual([])
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'], approvedAt: NOW - MINUTE })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
})

test('a dropped monitored thumbs-up retries when the same poll marks a later approval comment', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } },
    pull: { thumbsUpAt: NOW - 2 * MINUTE, comments: [{ at: NOW - MINUTE, body: 'Didn\'t find any major issues' }] },
    dropPrompt: true,
  })
  const record = 'pr:' + URL.toLowerCase()
  const previous = NOW - 3 * MINUTE
  w.store.set(record, { since: LAST_PUSH, approvedAt: previous, at: NOW - MINUTE })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('approved にしました（20:58）')])
  expect(w.store.get(record)).toMatchObject({ approvedAt: previous })
  w.dropPrompt = false
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(2)
  expect(w.prompts[1]).toBe(w.prompts[0])
  expect(w.store.get(record)).toMatchObject({ approvedAt: NOW - MINUTE })
  w.desktop = { primary: { number: 7, state: 'open' }, monitor: { auto_fix: false } }
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(2)
})

test('a monitored thumbs-up alone sends the usual approval prompt', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } },
    pull: { thumbsUpAt: NOW - MINUTE },
  })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  expect(w.prompts).toEqual([
    `Codex が PR #7 (${URL}) を approved にしました（20:59）。CI の結果を確かめ、問題がなければ作業の完了を報告してください。`,
  ])
})

// The newest fresh review supersedes approvals both before it and at its own timestamp
for (const offset of [0, MINUTE]) {
  test(`a monitored thumbs-up ${offset ? 'before' : 'at'} the newest review is marked silently`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const approvedAt = NOW - MINUTE - offset
    const w = stubWorld(on, {
      desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } },
      pull: { thumbsUpAt: approvedAt, reviews: [
        { id: 2, at: NOW - MINUTE, comments: 1 },
        { id: 1, at: NOW - 3 * MINUTE, comments: 1 },
      ] },
    })
    await $.session.start({ ...START, surface: 'desktop' })
    await clock.settle()
    await clock.advance(MINUTE)
    expect(w.prompts).toEqual([])
    expect(w.detailsArgv).toEqual([])
    expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1', '2'], approvedAt })
  })
}

test('a monitored usage limit is marked without a toast even after auto-fix is disabled', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } },
    pull: { comments: [{ at: NOW - MINUTE, body: 'You have reached your Codex usage limits for code reviews.' }] },
  })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ usageLimitAt: NOW - MINUTE })
  expect(w.toasts).toEqual([])
  w.desktop = { primary: { number: 7, state: 'open' }, monitor: { auto_fix: false } }
  await clock.advance(2 * MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.toasts).toEqual([])
})

// A failed approval delivery rolls back only the mark owned by that prompt
for (const failure of ['dropped', 'rejected']) {
  test(`a ${failure} monitored approval retries while keeping silent review and usage-limit marks`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let refuses = true
    const w = stubWorld(on, {
      desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: true } },
      pull: {
        thumbsUpAt: NOW - MINUTE,
        reviews: [{ id: 1, at: NOW - 2 * MINUTE, comments: 1 }],
        comments: [{ at: NOW - MINUTE, body: 'You have reached your Codex usage limits for code reviews.' }],
      },
      dropPrompt: failure === 'dropped',
      turnStarts: async () => {
        if (refuses && failure === 'rejected') throw new Error('the queue is closed')
      },
    })
    await $.session.start({ ...START, surface: 'desktop' })
    await clock.settle()
    expect(w.prompts.length).toBe(1)
    expect(w.prompts[0]?.endsWith(MONITORED_APPROVAL_NOTE)).toBe(true)
    expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'], approvedAt: 0, usageLimitAt: NOW - MINUTE })
    refuses = false
    w.dropPrompt = false
    await clock.advance(MINUTE)
    expect(w.prompts.length).toBe(2)
    expect(w.prompts[1]).toContain('approved にしました')
    expect(w.prompts[1]).not.toContain(MONITORED_APPROVAL_NOTE)
    expect(w.detailsArgv).toEqual([])
    expect(w.toasts).toEqual([])
    expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'], approvedAt: NOW - MINUTE, usageLimitAt: NOW - MINUTE })
    await clock.advance(MINUTE)
    expect(w.prompts.length).toBe(2)
  })
}

test('an unmonitored desktop primary still relays review details and usage-limit toasts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, monitor: { auto_fix: false } },
    pull: {
      thumbsUpAt: NOW - MINUTE,
      reviews: [{ id: 1, at: NOW - 2 * MINUTE, comments: 1 }],
      comments: [{ at: NOW - MINUTE, body: 'You have reached your Codex usage limits for code reviews.' }],
    },
  })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件、inline コメント 1 件')])
  expect(w.prompts[0]).toContain('### src/file-1.ts:1 (comment 1001)')
  expect(w.prompts[0]).toContain('なお、このレビューの後（20:59）')
  expect(w.detailsArgv.length).toBe(1)
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認')
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
  expect(w.toasts).toEqual(['PR #7: Codex の利用上限に達し、レビューが付きません'])
})

test('watches the desktop primary at startup without asking gh for the branch', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 9, state: 'open' } } })
  await $.session.start({ ...START, surface: 'desktop' })
  await clock.settle()

  expect(w.branchLookups).toBe(0)
  expect(w.desktopCalls).toBe(1)
  expect(w.queryArgv[0]).toEqual(expect.arrayContaining(['-F', 'number=9']))
  expect(w.status).toBe('PR #9 監視中 · 21:00 確認')
})

test('an incomplete desktop primary does not become or replace the known baseline', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 9 } } })
  await $.session.start(START)
  await clock.settle()
  expect(w.branchLookups).toBe(1)
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認')

  w.desktop = { primary: { number: 9, state: 'open' } }
  await clock.advance(MINUTE)
  expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.settle()
  w.desktop = { primary: { number: 10, state: 'unknown' } }
  await clock.advance(MINUTE)
  w.desktop = { primary: { number: 9, state: 'open' } }
  await clock.advance(MINUTE)
  expect(w.status).toBe('PR #7 監視中 · 21:03 確認')

  w.desktop = { primary: { number: 10, state: 'unknown' } }
  await clock.advance(MINUTE)
  w.desktop = { primary: { number: 10, state: 'open' } }
  await clock.advance(MINUTE)
  expect(w.status).toBe('PR #10 監視中 · 21:05 確認')
})

// A partial snapshot must not erase an open state before the app reports its merge
for (const field of ['omitted', 'not an array'] as const) {
  test(`other bound merges survive a snapshot whose otherBoundPrs is ${field}`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }] } })
    await $.session.start(START)
    await clock.settle()
    w.desktopResponse = JSON.stringify({
      bound: true,
      pr: { url: URL, state: 'open' },
      otherBoundPrs: field === 'omitted' ? undefined : {},
    })
    await clock.advance(MINUTE)
    w.desktopResponse = undefined
    w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }] }
    await clock.advance(MINUTE)

    expect(w.toasts).toEqual(['PR #9 がマージされました'])
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeDefined()
    expect(w.status).toBe('PR #7 監視中 · 21:02 確認')
  })
}

// A primary first seen ended takes over from the branch watch only once it becomes open
for (const state of ['merged', 'closed'] as const) {
  test(`a desktop primary first seen ${state} takes over when it opens`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { desktop: { primary: { number: 9, state } } })
    await $.session.start(START)
    await clock.settle()
    expect(w.status).toBe('PR #7 監視中 · 21:00 確認')
    expect(w.branchLookups).toBe(1)
    w.desktop = { primary: { number: 9, state: 'open' } }
    await clock.advance(MINUTE)
    expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
    expect(w.queryArgv[w.queryArgv.length - 1]).toEqual(expect.arrayContaining(['number=9']))

    await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
    await clock.settle()
    await clock.advance(MINUTE)
    expect(w.status).toBe('PR #7 監視中 · 21:02 確認')
  })
}

test('an omitted primary preserves an explicit watch and the primary state history', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }] } })
  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL.replace('/7', '/10') })
  await clock.settle()
  w.desktopResponse = JSON.stringify({ bound: true })
  await clock.advance(MINUTE)
  w.desktopResponse = undefined
  await clock.advance(MINUTE)
  expect(w.status).toBe('PR #10 監視中 · 21:02 確認')

  // A complete list of other PRs does not imply that the omitted primary was unbound
  w.desktopResponse = JSON.stringify({ bound: true, otherBoundPrs: [{ number: 9, repo: 'HolyGrail/claude-mods', state: 'open' }] })
  await clock.advance(MINUTE)
  w.desktopResponse = undefined
  w.desktop = { primary: { number: 7, state: 'closed' }, others: [{ number: 9, state: 'merged' }] }
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual(['PR #9 がマージされました', 'PR #7 がクローズされました'])
  expect(w.status).toBe('PR #10 監視中 · 21:04 確認')
})

test('an unwatched bound PR reopening removes only its cleanup row', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }, { number: 10, state: 'open' }] } })
  await $.session.start(START)
  await clock.settle()
  w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }, { number: 10, state: 'merged' }] }
  await clock.advance(MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeDefined()
  w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }, { number: 10, state: 'merged' }] }
  await clock.advance(MINUTE)

  expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeUndefined()
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase().replace('/7', '/10')}` })).toBeDefined()
  expect(w.status).toBe('PR #7 監視中 · 21:02 確認')
  expect(w.prompts).toEqual([])
})

// The desktop sets each cleanup row apart from the meters as a card; the terminal keeps one line each
for (const surface of ['desktop', 'terminal'] as const) {
  test(`cleanup rows on the ${surface} ${surface === 'desktop' ? 'are' : 'are not'} drawn as cards`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }] } })
    await $.session.start(START)
    await clock.settle()
    w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }] }
    await clock.advance(MINUTE)
    const ui = await $.ui.mount({ ...BAND, surface })

    const band = (await ui.drawn()) as { props: Record<string, unknown>; children: { props: Record<string, unknown> }[] }
    const [row] = band.children
    expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeDefined()
    if (surface === 'desktop') {
      expect(band.props).toMatchObject({ flexDirection: 'column', rowGap: 1 })
      expect(row?.props).toMatchObject({ flexDirection: 'row', borderStyle: 'round', paddingX: 1 })
    } else {
      expect(band.props.rowGap).toBeUndefined()
      expect(row?.props.borderStyle).toBeUndefined()
      expect(row?.props.paddingX).toBeUndefined()
    }
  })
}

test('a newly bound desktop primary takes over on the next tick', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'OPEN' } } })
  await $.session.start(START)
  await clock.settle()
  w.desktop = { primary: { number: 9, state: 'Open' }, others: [{ number: 7, state: 'open' }] }
  await clock.advance(MINUTE)

  expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
  expect(w.queryArgv[w.queryArgv.length - 1]).toEqual(expect.arrayContaining(['number=9']))
  expect(w.store.get(NOTE)).toMatchObject({ idle: true })
  expect(w.branchLookups).toBe(0)
  await clock.advance(MINUTE)
  expect(w.desktopCalls).toBe(3)
  expect(w.toolLists).toBe(1)
})

test('an unchanged desktop primary leaves an explicit watch alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' } } })
  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  // Repository casing does not make the primary a different pull request.
  w.desktopResponse = JSON.stringify({ pr: { url: URL.toLowerCase(), state: 'OPEN' } })
  await clock.advance(MINUTE)
  expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
  expect(w.queryArgv[w.queryArgv.length - 1]).toEqual(expect.arrayContaining(['number=9']))
})

test('an unchanged desktop primary leaves a newly created pull request watched', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' } } })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: PR9, stderr: '', interrupted: false }, text: PR9 }) as never)
  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'gh pr create' })
  await clock.settle()
  await clock.advance(MINUTE)
  expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
})

test('other bound merges have independent cleanup rows while the watched pull request keeps polling', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }, { number: 10, state: 'open' }] },
  })
  await $.session.start(START)
  await clock.settle()
  w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }, { number: 10, state: 'MERGED' }] }
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual(['PR #9 がマージされました', 'PR #10 がマージされました'])
  expect(w.status).toBe('PR #7 監視中 · 21:01 確認')
  expect(w.queries).toBe(2)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeDefined()
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase().replace('/7', '/10')}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'drawn by another mod' })).toBeDefined()
  await ui.press({ key: `cleanup-${PR9.toLowerCase()}` })
  expect(w.prompts).toEqual([
    `PR ${PR9} がマージされました。この PR のブランチの worktree とローカルブランチを片付けてください。\n` +
    `gh pr view ${PR9} --json headRefName,headRepository でブランチを確かめ、git worktree list でそのブランチを checkout している worktree を探してください。\n` +
    '見つからない場合や、別のリポジトリの PR の場合は、何も消さずに報告してください。\n' +
    '消す前に、未コミットの変更や push していないコミットが残っていないかを確かめ、残っていれば消さずに報告してください。',
  ])
  expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeUndefined()
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase().replace('/7', '/10')}` })).toBeDefined()
  await clock.advance(MINUTE)
  expect(w.queries).toBe(3)
  expect(w.toasts).toHaveLength(2)
})

test('cleanup identifies a bound pull request by its URL and checks its repository and worktree', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const foreign = 'https://github.com/Other/project/pull/9'
  const status = (state: string) => JSON.stringify({
    pr: { url: URL, state: 'open' },
    otherBoundPrs: [{ number: 9, repo: 'Other/project', state }],
  })
  const w = stubWorld(on, { desktopAvailable: true, desktopResponse: status('open') })
  await $.session.start(START)
  await clock.settle()
  w.desktopResponse = status('merged')
  await clock.advance(MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: `cleanup-${foreign.toLowerCase()}` })

  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain(`PR ${foreign} がマージされました。この PR のブランチの worktree とローカルブランチを片付けてください。`)
  expect(w.prompts[0]).toContain(`gh pr view ${foreign} --json headRefName,headRepository`)
  expect(w.prompts[0]).toContain('git worktree list でそのブランチを checkout している worktree を探してください。')
  expect(w.prompts[0]).toContain('見つからない場合や、別のリポジトリの PR の場合は、何も消さずに報告してください。')
  expect(w.prompts[0]).toContain('未コミットの変更や push していないコミットが残っていないかを確かめ、残っていれば消さずに報告してください。')
  expect(w.status).toBe('PR #7 監視中 · 21:01 確認')
})

// Removing all bindings and removing just one PR both make a later binding a first sighting
for (const all of [true, false]) {
  test(`a merged PR rebound after ${all ? 'all bindings were cleared' : 'it left the bound list'} raises no stale notification`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }] } })
    await $.session.start(START)
    await clock.settle()
    w.desktop = all ? {} : { primary: { number: 7, state: 'open' }, others: [] }
    await clock.advance(MINUTE)
    await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL.replace('/7', '/10') })
    await clock.settle()
    w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }] }
    await clock.advance(MINUTE)

    expect(w.toasts).toEqual([])
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.findAll({ type: 'Button', text: 'cleanup' })).toHaveLength(0)
    // Clearing every binding also clears the primary baseline; removing only the other PR does not.
    expect(w.status).toBe(`PR #${all ? 7 : 10} 監視中 · 21:02 確認`)
  })
}

// An open cache entry resumes an ended watch and removes any cleanup row it left
for (const state of ['CLOSED', 'MERGED'] as const) {
  test(`an ended desktop primary resumes polling when ${state.toLowerCase()} becomes open`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' } } })
    await $.session.start(START)
    await clock.settle()
    w.pull.state = state
    w.desktop = { primary: { number: 7, state: state.toLowerCase() } }
    await clock.advance(2 * MINUTE)
    expect(w.queries).toBe(2)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    if (state === 'MERGED') expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeDefined()

    w.pull.state = 'OPEN'
    w.desktop = { primary: { number: 7, state: 'open' } }
    await clock.advance(MINUTE)
    expect(w.status).toBe('PR #7 監視中 · 21:03 確認')
    expect(w.queries).toBe(3)
    expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeUndefined()
    await clock.advance(MINUTE)
    expect(w.queries).toBe(4)
  })
}

test('a primary outside the explicit watch is followed for close and merge only', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' } } })
  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  w.desktop = { primary: { number: 7, state: 'Closed' } }
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual(['PR #7 がクローズされました'])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Button', text: 'cleanup' })).toHaveLength(0)
  w.desktop = { primary: { number: 7, state: 'open' } }
  await clock.advance(MINUTE)
  // Reopening takes over the watch, so switch away again to follow the merge as another PR
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  w.desktop = { primary: { number: 7, state: 'merged' } }
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual(['PR #7 がクローズされました', 'PR #7 がマージされました'])
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeDefined()
  expect(w.status).toBe('PR #9 監視中 · 21:03 確認')
})

test('bound pull requests first seen ended raise no toast or cleanup row', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 9, state: 'merged' }, others: [{ number: 10, state: 'closed' }] } })
  await $.session.start(START)
  await clock.settle()
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual([])
  expect(w.branchLookups).toBe(1)
  expect(w.status).toBe('PR #7 監視中 · 21:01 確認')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Button', text: 'cleanup' })).toHaveLength(0)
})

test('dismissing one merged pull request leaves the other cleanup rows', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }] } })
  await $.session.start(START)
  await clock.settle()
  w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }] }
  await clock.advance(MINUTE)
  // The watched pull request contributes to the same list when its GraphQL poll sees the merge.
  w.pull.state = 'MERGED'
  w.desktop = { primary: { number: 7, state: 'merged' }, others: [{ number: 9, state: 'merged' }] }
  await clock.advance(MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeDefined()
  expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeDefined()
  await ui.press({ key: `dismiss-${URL.toLowerCase()}` })
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeUndefined()
  expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeDefined()
  await clock.advance(MINUTE)
  expect(w.desktopCalls).toBe(4)
  expect(w.queries).toBe(3)
  // Only the watched pull request's merge is posted to the other sessions
  expect(w.posts).toEqual(['/notice main advanced (#7). Rebase before the next push.'])
})

test('a rejected cleanup prompt restores its row beside the other offers', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }, { number: 10, state: 'open' }] },
    dropPrompt: true,
  })
  await $.session.start(START)
  await clock.settle()
  w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }, { number: 10, state: 'merged' }] }
  await clock.advance(MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: `cleanup-${PR9.toLowerCase()}` })
  expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeDefined()
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase().replace('/7', '/10')}` })).toBeDefined()
})

test('cleanup shows the three newest offers and keeps keys distinct across repositories', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const status = (state: string) => JSON.stringify({ otherBoundPrs: [
    { number: 9, repo: 'HolyGrail/one', state },
    { number: 9, repo: 'HolyGrail/two', state },
    { number: 9, repo: 'HolyGrail/three', state },
    { number: 9, repo: 'HolyGrail/four', state },
  ] })
  const w = stubWorld(on, { desktopAvailable: true, desktopResponse: status('open') })
  await $.session.start(START)
  await clock.settle()
  w.desktopResponse = status('merged')
  await clock.advance(MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const rows = await ui.findAll({ type: 'Button', text: 'cleanup' })
  expect(rows.map((row) => row.key)).toEqual(['four', 'three', 'two'].map((repo) => `cleanup-https://github.com/holygrail/${repo}/pull/9`))
  await ui.press({ key: 'dismiss-https://github.com/holygrail/three/pull/9' })
  expect(await ui.find({ key: 'cleanup-https://github.com/holygrail/four/pull/9' })).toBeDefined()
  expect(await ui.find({ key: 'cleanup-https://github.com/holygrail/one/pull/9' })).toBeDefined()
})

test('a delayed cleanup rejection restores its row behind newer merges', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }, { number: 10, state: 'open' }] },
    dropPrompt: true,
    turnStarts: () => clock.sleep(2 * MINUTE),
  })
  await $.session.start(START)
  await clock.settle()
  w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }, { number: 10, state: 'open' }] }
  await clock.advance(MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const press = ui.press({ key: `cleanup-${PR9.toLowerCase()}` })
  await clock.settle()
  expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeUndefined()
  w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }, { number: 10, state: 'merged' }] }
  await clock.advance(2 * MINUTE)
  await press
  const rows = await ui.findAll({ type: 'Button', text: 'cleanup' })
  expect(rows.map((row) => row.key)).toEqual([
    `cleanup-${URL.toLowerCase().replace('/7', '/10')}`,
    `cleanup-${PR9.toLowerCase()}`,
  ])
})

// Each unavailable or malformed response leaves the gh path and the existing watch usable
for (const failure of ['error', 'deny', 'unparsable', 'reject'] as const) {
  test(`desktop ${failure} falls back at startup and leaves later watches unchanged`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, {
      desktopAvailable: true,
      desktop: failure === 'error' || failure === 'deny' ? failure : {},
      desktopResponse: failure === 'unparsable' ? '{invalid json' : undefined,
      desktopThrows: failure === 'reject',
    })
    await $.session.start(START)
    await clock.settle()
    expect(w.branchLookups).toBe(1)
    expect(w.status).toBe('PR #7 監視中 · 21:00 確認')
    await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
    await clock.settle()
    await clock.advance(MINUTE)
    expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
    expect(w.toasts).toEqual([])
    expect(w.desktopCalls).toBe(2)
    expect(w.toolLists).toBe(1)
  })
}

test('absent fields and non-GitHub primaries leave branch discovery available', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktopAvailable: true, desktopResponse: '{}' })
  await $.session.start(START)
  await clock.settle()
  expect(w.branchLookups).toBe(1)
  w.desktopResponse = JSON.stringify({ pr: { url: PR9, state: 'open', host: 'enterprise.example.com' }, otherBoundPrs: [null, {}, { repo: 'bad/repo/path', number: 9, state: 'open' }] })
  await clock.advance(MINUTE)
  expect(w.status).toBe('PR #7 監視中 · 21:01 確認')
  expect(w.toasts).toEqual([])
})

test('a failed tool list stays unavailable until the conversation restarts', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 9, state: 'open' } }, toolListError: true })
  await $.session.start(START)
  await clock.settle()
  w.toolListError = false
  await clock.advance(MINUTE)
  expect(w.desktopCalls).toBe(0)
  expect(w.toolLists).toBe(1)
  expect(w.status).toBe('PR #7 監視中 · 21:01 確認')
  await $.session.start(START)
  await clock.settle()
  expect(w.toolLists).toBe(2)
  expect(w.status).toBe('PR #9 監視中 · 21:01 確認')
})

// Conversation switches must forget the previous primary, states, offers and tool availability
for (const source of ['resume', 'clear', 'fork'] as const) {
  test(`${source} starts fresh desktop tracking with one timer`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }, { number: 10, state: 'open' }] } })
    on('classic.SessionStart', () => ({}))
    await $.session.start(START)
    await clock.settle()
    w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }, { number: 10, state: 'open' }] }
    await clock.advance(MINUTE)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeDefined()
    w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 10, state: 'merged' }] }
    w.sessionId = 'next-session'
    await $.classic.SessionStart({ source })
    await clock.settle()
    expect(await ui.find({ key: `cleanup-${PR9.toLowerCase()}` })).toBeUndefined()
    expect(w.status).toBe('PR #7 監視中 · 21:01 確認')
    await clock.advance(MINUTE)
    expect(w.toolLists).toBe(2)
    expect(w.desktopCalls).toBe(4)
    expect(w.toasts).toEqual(['PR #9 がマージされました'])
  })
}

test('a desktop read begun before a newer watch cannot switch it or report other merges', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 10, state: 'open' }] } })
  await $.session.start(START)
  await clock.settle()
  w.desktop = { primary: { number: 9, state: 'open' }, others: [{ number: 10, state: 'merged' }] }
  w.desktopAnswers = () => clock.sleep(10_000)
  await clock.advance(MINUTE)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.settle()
  await clock.advance(10_000)
  expect(w.toasts).toEqual([])
  expect(w.status).toBe('PR #7 監視中 · 21:01 確認')
  w.desktopAnswers = undefined
  await clock.advance(MINUTE - 10_000)
  expect(w.status).toBe('PR #9 監視中 · 21:02 確認')
  expect(w.toasts).toEqual(['PR #10 がマージされました'])
})

test('desktop discovery begun before an explicit watch leaves it alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 9, state: 'open' } }, desktopAnswers: () => clock.sleep(10_000) })
  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.settle()
  await clock.advance(10_000)
  expect(w.branchLookups).toBe(0)
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認')
})

test('a final session end cancels the desktop timer and ignores its pending read', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'open' }] } })
  on('session.end', () => ({ sessionId: 'session-b' }))
  await $.session.start(START)
  await clock.settle()
  w.desktop = { primary: { number: 7, state: 'open' }, others: [{ number: 9, state: 'merged' }] }
  w.desktopAnswers = () => clock.sleep(10_000)
  await clock.advance(MINUTE)
  await $.session.end({ reason: 'other', sessionId: 'session-b', resume: { id: 'session-b' } })
  const queries = w.queries
  await clock.advance(3 * MINUTE)
  expect(w.desktopCalls).toBe(2)
  expect(w.queries).toBe(queries)
  expect(w.toasts).toEqual([])
})

test('a failed desktop read preserves the primary baseline until it recovers', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { desktop: { primary: { number: 7, state: 'open' } } })
  await $.session.start(START)
  await clock.settle()
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.settle()
  w.desktop = 'deny'
  await clock.advance(MINUTE)
  w.desktop = { primary: { number: 7, state: 'open' } }
  await clock.advance(MINUTE)
  expect(w.status).toBe('PR #9 監視中 · 21:02 確認')
})

test('a terminal session never calls the desktop status tool', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()
  await clock.advance(3 * MINUTE)
  expect(w.desktopCalls).toBe(0)
  expect(w.toolLists).toBe(1)
  expect(w.queries).toBe(4)
})

test('watches the branch pull request without reading skill session files', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  const fileCalls: string[] = []
  mock.env(on, { HOME: '/home' })
  // Any skill session lookup would find a different pull request in the same checkout.
  on('fs.list', ($, e) => {
    fileCalls.push(e.path)
    return { value: [{ name: 'feature.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }
  })
  on('fs.read', ($, e) => {
    fileCalls.push(e.path)
    return { value: JSON.stringify({ worktree_path: '/repo', pr_url: PR9, status: 'pr-open' }) }
  })
  await $.session.start(START)
  // The pull request is looked up once the session is ready.
  await clock.settle()

  expect(w.queries).toBe(1)
  // The repository goes as a string whatever it is named, the number as a number.
  expect(w.queryArgv[0]).toEqual(expect.arrayContaining(['-f', 'owner=HolyGrail', '-f', 'name=claude-mods', '-F', 'number=7']))
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認')
  expect(w.prompts).toEqual([])
  await clock.advance(MINUTE)
  expect(w.queries).toBe(2)
  expect(fileCalls).toEqual([])
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
  expect(w.prompts).toEqual([
    `Codex が PR #7 (${URL}) を approved にしました（21:00）。CI の結果を確かめ、問題がなければ作業の完了を報告してください。`,
  ])

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

test('a review prompt lists inline comments in review order with the original opening', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: {
      reviews: [
        { id: 2, nodeId: 'PRR_second', at: NOW - MINUTE, comments: 1, details: [
          { id: 21, path: 'src/c.ts', line: 8, body: '空の配列を扱ってください。' },
        ] },
        { id: 1, nodeId: 'PRR_first', at: NOW - 2 * MINUTE, comments: 2, body: 'boilerplate', details: [
          { id: 12, path: 'src/b.ts', line: 20, body: '  エラーを返してください。\n' },
          { id: 11, path: 'src/a.ts', line: 12, body: '\nnull を確認してください。  ' },
        ] },
        { id: 3, at: LAST_PUSH - MINUTE, comments: 1 },
        { id: 4, at: NOW - MINUTE, comments: 1, by: 'someone' },
      ],
    },
  })
  await $.session.start(START)
  await clock.settle()

  expect(w.prompts).toEqual([
    `Codex が PR #7 (${URL}) にレビューを付けました（レビュー 2 件、inline コメント 3 件）。\n` +
    '指摘を一つずつ確かめ、妥当なものは直して push し、妥当でないものは理由を添えてそのコメントに返信してください。\n' +
    '返信は gh api repos/HolyGrail/claude-mods/pulls/7/comments/<comment id>/replies -f body=\'...\' で送れます。\n\n' +
    `### src/b.ts:20 (comment 12)\nエラーを返してください。\n${URL}#discussion_r12\n\n` +
    `### src/a.ts:12 (comment 11)\nnull を確認してください。\n${URL}#discussion_r11\n\n` +
    `### src/c.ts:8 (comment 21)\n空の配列を扱ってください。\n${URL}#discussion_r21`,
  ])
  expect(w.detailsArgv.length).toBe(1)
  expect(w.detailsArgv[0]?.slice(5)).toEqual(['-f', 'ids[]=PRR_first', '-f', 'ids[]=PRR_second'])
  expect(w.queryArgv[0]?.join(' ')).not.toContain('comments(first: 100)')
  expect(w.queryArgv[0]?.join(' ')).not.toContain('originalLine')
})

test('outdated inline comments use the original line for both GitHub signals', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 2, details: [
      { id: 11, path: 'src/a.ts', line: null, originalLine: 42, body: 'Old line' },
      { id: 12, path: 'src/b.ts', line: 9, originalLine: 10, outdated: true, body: 'Old diff' },
    ] }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts[0]).toContain('### src/a.ts:42 (outdated) (comment 11)')
  expect(w.prompts[0]).toContain('### src/b.ts:10 (outdated) (comment 12)')
})

test('a file-level comment has a file heading even when its line is null or it is outdated', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 3, details: [
      { id: 11, path: 'whole.ts', line: null, subjectType: 'FILE', body: 'Check the whole file' },
      { id: 12, path: 'old-file.ts', line: null, originalLine: 9, subjectType: 'FILE', outdated: true, body: 'File finding' },
      { id: 13, path: 'line.ts', line: null, originalLine: 42, subjectType: 'LINE', body: 'Line finding' },
    ] }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.detailsArgv[0]?.join(' ')).toContain('subjectType')
  expect(w.prompts[0]).toContain('### whole.ts (file) (comment 11)\nCheck the whole file')
  expect(w.prompts[0]).toContain('### old-file.ts (file) (comment 12)\nFile finding')
  expect(w.prompts[0]).toContain('### line.ts:42 (outdated) (comment 13)\nLine finding')
})

test('review thread replies are neither findings nor newly fetched omitted comments', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1, detailsTotal: 3, details: [
      { id: 11, path: 'src/a.ts', line: 1, body: 'Codex finding' },
      { id: 12, path: 'src/a.ts', line: 1, body: 'A rebuttal', replyTo: { id: 'comment-11' } },
      { id: 13, path: 'src/a.ts', line: 1, body: 'A follow-up', replyTo: { id: 'comment-11' } },
    ] }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.detailsArgv[0]?.join(' ')).toContain('replyTo { id }')
  expect(w.prompts[0]).toContain('### src/a.ts:1 (comment 11)\nCodex finding')
  expect(w.prompts[0]).not.toContain('A rebuttal')
  expect(w.prompts[0]).not.toContain('A follow-up')
  expect(w.prompts[0]).not.toContain('残り')
})

test('a numeric review mark is not resent when GitHub supplies its fullDatabaseId as a string', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [{ id: null, fullDatabaseId: '5398198804', at: NOW - MINUTE, comments: 1 }] },
  })
  const record = 'pr:' + URL.toLowerCase()
  w.store.set(record, { since: LAST_PUSH, head: 'a1', reviews: [5398198804], at: NOW - MINUTE })
  await $.session.start(START)
  await clock.settle()
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.detailsArgv).toEqual([])
  expect(w.store.get(record)).toMatchObject({ reviews: ['5398198804'] })
})

test('large review ids match their details and retain every digit in headings and records', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [
      { id: null, fullDatabaseId: '5398198804', at: NOW - 3 * MINUTE, comments: 0, body: 'Body-only finding' },
      { id: null, fullDatabaseId: '9007199254740993', at: NOW - 2 * MINUTE, comments: 1, details: [
        { id: 21, path: 'large.ts', line: 7, body: 'Inline finding' },
      ] },
      { id: 3, at: NOW - MINUTE, comments: 0, body: 'Legacy review' },
    ] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.queryArgv[0]?.join(' ')).toContain('id databaseId fullDatabaseId submittedAt')
  expect(w.detailsArgv[0]?.join(' ')).toContain('databaseId fullDatabaseId url')
  expect(w.prompts[0]).toContain('### レビュー 5398198804\nBody-only finding')
  expect(w.prompts[0]).toContain('### large.ts:7 (comment 21)\nInline finding')
  expect(w.prompts[0]).toContain('### レビュー 3\nLegacy review')
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['5398198804', '9007199254740993', '3'] })
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
})

test('inline comment ids use fullDatabaseId without losing large ids or changing review marks', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 3, details: [
      { id: null, fullDatabaseId: '4170981226', path: 'large.ts', line: 1, body: 'Beyond 32 bits' },
      { id: 17, fullDatabaseId: '9007199254740993', path: 'precise.ts', line: 2, body: 'Keep every digit' },
      { id: 19, fullDatabaseId: null, path: 'legacy.ts', line: 3, body: 'Legacy id' },
    ] }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.detailsArgv[0]?.join(' ')).toContain('databaseId fullDatabaseId path')
  expect(w.prompts[0]).toContain(`### large.ts:1 (comment 4170981226)\nBeyond 32 bits\n${URL}#discussion_r4170981226`)
  expect(w.prompts[0]).toContain('### precise.ts:2 (comment 9007199254740993)\nKeep every digit')
  expect(w.prompts[0]).toContain('### legacy.ts:3 (comment 19)\nLegacy id')
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'] })
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
})

test('inline bodies are trimmed and cut at 4000 characters before the truncation notice', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 2, details: [
      { id: 11, path: 'long.ts', line: 1, body: '  ' + 'x'.repeat(4_000) + 'CUT  ' },
      { id: 12, path: 'exact.ts', line: 2, body: '\n' + 'y'.repeat(4_000) + '  ' },
    ] }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts[0]).toContain('\n' + 'x'.repeat(4_000) + '…（以下省略、全文は URL で）\n')
  expect(w.prompts[0]).not.toContain('CUT')
  expect(w.prompts[0]).toContain('\n' + 'y'.repeat(4_000) + '\n')
})

test('a prompt stays under 30000 characters and counts fetched and unfetched comments left out', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 12, details: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, path: `file-${i + 1}.ts`, line: i + 1, body: 'x'.repeat(4_001),
    })) }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts[0]?.length).toBeLessThanOrEqual(30_000)
  expect(w.prompts[0]).toContain('### file-7.ts:7 (comment 7)')
  expect(w.prompts[0]).not.toContain('### file-8.ts')
  expect(w.prompts[0]?.endsWith(`残り 5 件のコメントは ${URL}/files で確認してください。`)).toBe(true)
})

test('a review with more than 100 comments links to the comments beyond the details page', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 103 }] } })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts[0]).toContain('### src/file-100.ts:100 (comment 1100)')
  expect(w.prompts[0]?.endsWith(`残り 3 件のコメントは ${URL}/files で確認してください。`)).toBe(true)
  expect(w.detailsArgv.length).toBe(1)
})

for (const withComments of [false, true]) {
  test(`the prompt cap reports omitted review bodies${withComments ? ' together with unfetched comments' : ''}`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const reviews: Review[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1, at: NOW - (11 - i) * MINUTE, comments: 0, body: 'x'.repeat(4_000),
    }))
    if (withComments) reviews.unshift({
      id: 100, at: NOW - 12 * MINUTE, comments: 5,
      details: [{ id: 1001, path: 'file.ts', line: 1, body: 'x'.repeat(4_000) }],
    })
    const w = stubWorld(on, { pull: { reviews } })
    await $.session.start(START)
    await clock.settle()
    const lastBody = withComments ? 6 : 7
    expect(w.prompts[0]?.length).toBeLessThanOrEqual(30_000)
    expect(w.prompts[0]).toContain(`### レビュー ${lastBody}\n`)
    expect(w.prompts[0]).not.toContain(`### レビュー ${lastBody + 1}\n`)
    expect(w.prompts[0]?.endsWith(`残り ${withComments ? 8 : 3} 件のコメントとレビュー本文は ${URL} で確認してください。`)).toBe(true)
  })
}

test('a review without inline comments includes its capped body without details blocks', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 0,
      body: '<details>\nHidden instructions\n</details>  ' + 'x'.repeat(4_001) + '\n<details open>More boilerplate</details>',
    }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts[0]).toContain('### レビュー 1\n' + 'x'.repeat(4_000) + '…（以下省略、全文は URL で）\n')
  expect(w.prompts[0]).not.toContain('Hidden instructions')
  expect(w.prompts[0]).not.toContain('More boilerplate')
})

for (const failure of [
  { name: 'fails', world: { detailsError: 'error connecting to api.github.com\nMore details' } },
  { name: 'returns no usable nodes', world: { detailsResponse: '{"data":{"nodes":[null,{}]}}' } },
  { name: 'returns truncated JSON', world: { detailsResponse: '{"data":' } },
  { name: 'returns a comment line that throws when formatted', world: { detailsResponse: JSON.stringify({
    data: { nodes: [{ databaseId: 1, comments: { totalCount: 3, nodes: [
      { databaseId: 11, path: 'file.ts', line: { toString: null }, body: 'Comment', url: `${URL}#discussion_r11` },
    ] } }] },
  }) } },
]) {
  test(`a details fetch that ${failure.name} still wakes once and keeps its marks`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, {
      pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 3 }] },
      ...failure.world,
    })
    await $.session.start(START)
    await clock.settle()
    expect(w.prompts).toEqual([
      `Codex が PR #7 (${URL}) にレビューを付けました（レビュー 1 件、inline コメント 3 件）。\n` +
      '指摘を一つずつ確かめ、妥当なものは直して push し、妥当でないものは理由を添えてそのコメントに返信してください。\n' +
      '返信は gh api repos/HolyGrail/claude-mods/pulls/7/comments/<comment id>/replies -f body=\'...\' で送れます。\n' +
      'コメントは gh api --paginate repos/HolyGrail/claude-mods/pulls/7/comments --jq \'.[] | select(.in_reply_to_id == null and ((.pull_request_review_id | tostring) == "1")) | {id, path, line, body}\' で確認してください。',
    ])
    expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'] })
    await clock.advance(2 * MINUTE)
    expect(w.prompts.length).toBe(1)
    expect(w.detailsArgv.length).toBe(1)
  })
}

test('the fallback paginates comments and filters to every review reported by the prompt', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [
      { id: 11, fullDatabaseId: '5398198804', at: NOW - 3 * MINUTE, comments: 1 },
      { id: 12, at: NOW - 2 * MINUTE, comments: 2 },
      { id: 13, at: LAST_PUSH - MINUTE, comments: 1 },
      { id: 14, at: NOW - MINUTE, comments: 1, by: 'someone' },
      { id: 15, at: NOW - MINUTE, comments: 1 },
    ] },
    detailsError: 'error connecting to api.github.com',
  })
  w.store.set('pr:' + URL.toLowerCase(), { since: LAST_PUSH, head: 'a1', reviews: [15], at: NOW - MINUTE })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts[0]).toContain('レビュー 2 件、inline コメント 3 件')
  expect(w.prompts[0]?.split('\n').pop()).toBe(
    'コメントは gh api --paginate repos/HolyGrail/claude-mods/pulls/7/comments --jq \'.[] | select(.in_reply_to_id == null and ((.pull_request_review_id | tostring) == "5398198804" or (.pull_request_review_id | tostring) == "12")) | {id, path, line, body}\' で確認してください。',
  )
  await clock.advance(2 * MINUTE)
  expect(w.prompts.length).toBe(1)
})

test('review details wait for the record write and do not hold up later polls', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] },
    sets: (key) => key.startsWith('pr:') ? clock.sleep(5_000) : Promise.resolve(),
    detailsAnswer: () => clock.sleep(2 * MINUTE),
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.detailsArgv.length).toBe(0)
  await clock.advance(5_000)
  expect(w.detailsArgv.length).toBe(1)
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'] })
  w.sets = undefined
  await clock.advance(MINUTE)
  expect(w.queries).toBe(2)
  expect(w.prompts).toEqual([])
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
  expect(w.detailsArgv.length).toBe(1)
})

test('a push during review details takes back the old head review even if the push finishes before delivery', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { head: 'a1a1a1a0123456789', thumbsUpAt: NOW - MINUTE, reviews: [{ id: 1, at: NOW - 2 * MINUTE, comments: 1 }] },
    detailsAnswer: () => clock.sleep(20_000),
  })
  const pushed = '   a1a1a1a..b2b2b2b  feature -> feature\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()
  const record = 'pr:' + URL.toLowerCase()
  expect(w.detailsArgv.length).toBe(1)
  expect(w.store.get(record)).toMatchObject({ reviews: ['1'], approvedAt: NOW - MINUTE })

  await clock.advance(5_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.pull.head = 'b2b2b2b0123456789'
  await clock.advance(15_000)
  expect(w.prompts).toEqual([])
  expect(w.store.get(record)).toMatchObject({ reviews: [], approvedAt: 0 })

  w.detailsAnswer = undefined
  w.pull.reviews?.push({ id: 2, at: NOW + 30_000, comments: 1 })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('(comment 2001)')])
  expect(w.store.get(record)).toMatchObject({ reviews: ['2'], since: NOW + 5_000 })
})

for (const source of ['resume', 'clear', 'fork'] as const) {
  test(`a ${source} during review details takes back the old prompt and lets the next watch resend it`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, {
      pull: { thumbsUpAt: NOW - MINUTE, reviews: [{ id: 1, at: NOW - 2 * MINUTE, comments: 1 }] },
      pulls: { 9: {} },
      detailsAnswer: () => clock.sleep(20_000),
    })
    on('classic.SessionStart', () => ({}))
    await $.session.start(START)
    await clock.settle()
    expect(w.detailsArgv.length).toBe(1)
    const record = 'pr:' + URL.toLowerCase()
    expect(w.store.get(record)).toMatchObject({ reviews: ['1'], approvedAt: NOW - MINUTE })

    // A resume of the same pull request also changes the conversation that owns this delivery
    w.branchPr = { url: source === 'resume' ? URL : PR9, state: 'OPEN' }
    w.sessionId = 'session-c'
    await $.classic.SessionStart({ source })
    await clock.advance(20_000)
    expect(w.prompts).toEqual([])
    expect(w.store.get(record)).toMatchObject({ reviews: [], approvedAt: 0 })

    w.detailsAnswer = undefined
    await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL, since: iso(LAST_PUSH) })
    await clock.settle()
    expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
    expect(w.store.get(record)).toMatchObject({ reviews: ['1'], approvedAt: NOW - MINUTE })
    await clock.advance(MINUTE)
    expect(w.prompts.length).toBe(1)
  })
}

test('unrelayed reviews precede a later thumbs-up and carry its approval in one prompt', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { thumbsUpAt: NOW - MINUTE, reviews: [{ id: 1, at: NOW - 2 * MINUTE, comments: 1 }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts[0]).toContain('レビュー 1 件、inline コメント 1 件')
  expect(w.prompts[0]?.endsWith('なお、このレビューの後（20:59）に Codex が 👍 を付けています。指摘に対応して push しない場合は、approved とみなしてかまいません。')).toBe(true)
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'], approvedAt: NOW - MINUTE })
  await clock.advance(2 * MINUTE)
  expect(w.prompts.length).toBe(1)
})

test('an approval at the newest review time is marked without an approval note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { thumbsUpAt: NOW - MINUTE, reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts[0]).not.toContain('なお、このレビューの後')
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ approvedAt: NOW - MINUTE })
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
  expect(w.posts).toEqual(['/notice main advanced (#7). Rebase before the next push.'])

  await clock.advance(5 * MINUTE)
  expect(w.queries).toBe(2)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'PR #7 がマージされました' })).toBeDefined()
  await ui.press({ key: `cleanup-${URL.toLowerCase()}` })
  expect(w.prompts).toEqual([
    `PR ${URL} がマージされました。この PR のブランチの worktree とローカルブランチを片付けてください。\n` +
    `gh pr view ${URL} --json headRefName,headRepository でブランチを確かめ、git worktree list でそのブランチを checkout している worktree を探してください。\n` +
    '見つからない場合や、別のリポジトリの PR の場合は、何も消さずに報告してください。\n' +
    '消す前に、未コミットの変更や push していないコミットが残っていないかを確かめ、残っていれば消さずに報告してください。',
  ])
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeUndefined()
})

test('a pull request the session creates is watched from then on, without holding up the call', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // Codex reviews it as soon as it opens, before the first poll
  const w = stubWorld(on, {
    branchPr: null,
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

for (const command of [
  'gh pr new',
  'gh -R HolyGrail/claude-mods pr create',
  'gh -RHolyGrail/claude-mods pr create',
  'gh --repo=HolyGrail/claude-mods pr create',
  'gh --repo HolyGrail/claude-mods pr create',
  'gh -R "HolyGrail/claude-mods" pr new',
  'gh --repo=\'HolyGrail/claude-mods\' pr create',
  'cd x && gh pr new',
  'gh pr create; echo done',
  'gh pr new& wait',
  'gh pr create|cat',
  '(gh pr new)',
]) {
  test(`${command} watches the printed pull request URL`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { branchPr: null })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: URL + '\n', stderr: '', interrupted: false }, text: URL }) as never)
    await $.session.start(START)
    await clock.settle()

    await $.tool.call({ tool: 'Bash', command })
    await clock.settle()
    expect(w.queries).toBe(1)
    expect(w.queryArgv[0]).toContain('number=7')
    expect(w.status).toBe('PR #7 監視中 · 21:00 確認')
  })
}

for (const command of [
  'git pushx',
  'git -C other push-deploy',
  'gh pr create-extra',
  'gh pr new-extra',
  'gh prx create',
  'gh --repoHolyGrail/claude-mods pr create',
  'git log --grep push',
]) {
  test(`${command} does not start watching or look up a pull request`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { branchPr: null })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: URL, stderr: '', interrupted: false }, text: URL }) as never)
    await $.session.start(START)
    await clock.settle()
    w.branchPr = { url: URL, state: 'OPEN' }

    await $.tool.call({ tool: 'Bash', command })
    await clock.settle()
    expect(w.branchLookups).toBe(1)
    expect(w.queries).toBe(0)
  })
}

for (const command of [
  'git -C ../other push',
  'git -c push.default=current push',
  'git --no-pager -C "/repo/.wt/x" push',
  'git --git-dir=/repo/.git push',
  'git --work-tree=\'/repo/other tree\' push',
  'git -c "push.default=current" --git-dir="/repo/other tree/.git" --work-tree /repo --no-pager -C ../other push',
  'cd x && git push',
]) {
  test(`${command} excludes a thumbs-up from before the push`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
    await $.session.start(START)
    await clock.settle()

    w.pull.thumbsUpAt = NOW + 10_000
    await clock.advance(30_000)
    await $.tool.call({ tool: 'Bash', command })
    w.pull.head = 'b2'
    await clock.advance(30_000)
    expect(w.prompts).toEqual([])
  })
}

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

test('a newer head commit moves the baseline after an unseen push', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  // The push went unseen here (git -C, a script); its head was committed after the old thumbs-up.
  w.pull.thumbsUpAt = NOW + 10_000
  w.pull.head = 'b2'
  w.pull.committedAt = NOW + 20_000
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ since: NOW + 20_000 })
})

test('a pull request gh could not look up at startup is looked up again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { branchPr: 'error' })
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

test('poll-codex-review.sh --watch reaches Bash while the pull request is watched', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  stubWorld(on)
  let called = false
  on('tool.call', { tool: 'Bash' }, () => {
    called = true
    return { result: { stdout: '{}', stderr: '', interrupted: false }, text: '{}' } as never
  })
  await $.session.start(START)
  await clock.settle()

  const command = `"${POLL}" HolyGrail/claude-mods 7 2026-10-01T11:30:00Z --watch`
  const ran = await $.tool.call({ tool: 'Bash', command })
  expect(called).toBe(true)
  expect(ran.deny).toBeUndefined()
})

test('the watch tool reports what is watched and watches the pull request it is given', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { branchPr: null })
  await $.session.start(START)
  await clock.settle()

  const idle = await $.tool.call({ tool: 'mcp__pr-relay__watch' })
  expect(idle.result).toBe('pr-relay is not watching a pull request in this session.')

  const watching = await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL, since: iso(LAST_PUSH) })
  expect(watching.result).toContain(`pr-relay is watching ${URL}`)
  await clock.settle()
  expect(w.queries).toBe(1)
})

test('a review supersedes an earlier approval without another approval prompt', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { thumbsUpAt: NOW - 10 * MINUTE, reviews: [{ id: 1, at: NOW - 5 * MINUTE, comments: 3 }] },
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('inline コメント 3 件')])
  expect(w.prompts[0]).not.toContain('なお、このレビューの後')
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ approvedAt: NOW - 10 * MINUTE, reviews: ['1'] })

  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
})

test('a merge notice names the branch the pull request merged into', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { remote: 'https://github.com/holygrail/Claude-Mods' })
  await $.session.start(START)
  await clock.settle()

  w.pull = { state: 'MERGED', base: 'release/1.x' }
  await clock.advance(MINUTE)
  expect(w.posts).toEqual(['/notice release/1.x advanced (#7). Rebase before the next push.'])
})

test('a merge notice is posted from an origin that uses GitHub\'s SSH over port 443', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { remote: 'ssh://git@ssh.github.com:443/HolyGrail/claude-mods.git' })
  await $.session.start(START)
  await clock.settle()

  w.pull.state = 'MERGED'
  await clock.advance(MINUTE)
  expect(w.posts).toEqual(['/notice main advanced (#7). Rebase before the next push.'])
})

test('a pull request closed without a merge posts no notice', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  w.pull.state = 'CLOSED'
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual(['PR #7 がクローズされました'])
  expect(w.posts).toEqual([])
})

for (const remote of ['git@github.com:HolyGrail/other.git', 'https://notgithub.com/HolyGrail/claude-mods', null]) {
  test(`a merge posts no notice from a session whose repository is not the pull request's: ${remote}`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { remote })
    await $.session.start(START)
    await clock.settle()

    w.pull.state = 'MERGED'
    await clock.advance(MINUTE)
    expect(w.toasts).toEqual(['PR #7 がマージされました'])
    expect(w.posts).toEqual([])
  })
}

test('a merge is still told where /notice is unknown', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { postError: 'unknown command: notice' })
  await $.session.start(START)
  await clock.settle()

  w.pull.state = 'MERGED'
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual(['PR #7 がマージされました'])
  expect(w.status).toBe('PR #7 マージ済み')
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ ended: 'MERGED' })
})

test('a session that finds the merge already in the record posts no second notice', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { state: 'MERGED' } })
  w.store.set('pr:' + URL.toLowerCase(), { since: LAST_PUSH, head: 'a1', approvedAt: 0, usageLimitAt: 0, reviews: [], ended: 'MERGED', at: NOW - MINUTE })
  await $.session.start(START)
  await clock.settle()

  expect(w.toasts).toEqual([])
  expect(w.posts).toEqual([])
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
  const w = stubWorld(on, { branchPr: { url: 'https://github.com/HolyGrail/claude-mods/pull/3', state: 'OPEN' } })
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

for (const failure of ['dropped', 'rejected']) {
  test(`a ${failure} review prompt takes back its reviews and its approval mark`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    let refuses = true
    const w = stubWorld(on, {
      pull: { thumbsUpAt: NOW - MINUTE, reviews: [{ id: 1, at: NOW - 2 * MINUTE, comments: 1 }] },
      dropPrompt: failure === 'dropped',
      turnStarts: async () => {
        if (refuses && failure === 'rejected') throw new Error('the queue is closed')
      },
    })
    const record = 'pr:' + URL.toLowerCase()
    w.store.set(record, { since: LAST_PUSH, head: 'a1', approvedAt: NOW - 3 * MINUTE, reviews: [], at: NOW - MINUTE })
    await $.session.start(START)
    await clock.settle()
    expect(w.prompts.length).toBe(1)
    expect(w.store.get(record)).toMatchObject({ reviews: [], approvedAt: NOW - 3 * MINUTE })

    refuses = false
    w.dropPrompt = false
    await clock.advance(MINUTE)
    expect(w.prompts.length).toBe(2)
    expect(w.prompts[1]).toBe(w.prompts[0])
    expect(w.store.get(record)).toMatchObject({ reviews: ['1'], approvedAt: NOW - MINUTE })
    await clock.advance(MINUTE)
    expect(w.prompts.length).toBe(2)
  })
}

test('a dropped review takes back its mark even when an approval was already recorded before delivery', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, {
    pull: { thumbsUpAt: NOW - MINUTE, reviews: [{ id: 1, at: NOW - 2 * MINUTE, comments: 1 }] },
    dropPrompt: true,
  })
  const record = 'pr:' + URL.toLowerCase()
  w.store.set(record, { since: LAST_PUSH, head: 'a1', approvedAt: NOW - MINUTE, reviews: [], at: NOW - MINUTE })
  await $.session.start(START)
  await clock.settle()
  expect(w.store.get(record)).toMatchObject({ reviews: [], approvedAt: NOW - MINUTE })
})

test('a pull request found after a push takes that push as its baseline', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { branchPr: null })
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

for (const [command, cwd] of [
  ['git -C /repo/.wt/other push', '/repo/.wt/other'],
  ['git -C ../other push', '/repo/../other'],
  ['git -C .wt/other push', '/repo/.wt/other'],
  ['git --no-pager -C "/repo/.wt/other tree" push', '/repo/.wt/other tree'],
  ['git -C \'../other tree\' push', '/repo/../other tree'],
  ['git -C /repo -c push.default=current -C .wt -C ../other push', '/repo/.wt/../other'],
  ['git -C /a/b -C ../c push', '/a/b/../c'],
  ['git -C ../ignored -C /repo/.wt/other push', '/repo/.wt/other'],
  ['git -C /repo/.wt -C "" -C other push', '/repo/.wt/other'],
  ['git -c "alias.example=!git -C /wrong push" -C .wt/other push', '/repo/.wt/other'],
  ['git --git-dir=/other/.git --work-tree=/other push', '/other'],
  ['git --git-dir=/other/.git --work-tree \'/other tree\' push', '/other tree'],
  ['git --work-tree=other push', '/repo/other'],
  ['git -C /repo/.wt --work-tree=../other push', '/repo/.wt/../other'],
  ['git --work-tree ../other -C /repo -C .wt push', '/repo/.wt/../other'],
  ['git -C /repo/.wt --work-tree=/other push', '/other'],
  ['git --work-tree=/first --work-tree=/other push', '/other'],
  ['git -C ~/other push', '/home/tester/other'],
  ['git -C "~/other" push', '/repo/~/other'],
  ['git -C \'~/other\' push', '/repo/~/other'],
  ['git -C "~" push', '/repo/~'],
  ['git -C "~someone/other" push', '/repo/~someone/other'],
  ['git -C ~ push', '/home/tester'],
  ['git -C /repo/.wt --work-tree=~/other push', '/home/tester/other'],
  ['git -C /repo/.wt --work-tree="~/other" push', '/repo/.wt/~/other'],
  ['git -C ~ -C projects --work-tree ../other push', '/home/tester/projects/../other'],
  ['git push', undefined],
  ['git --git-dir=/other/.git push', undefined],
  ['git -c "alias.example=!git -C /wrong push" --git-dir=/repo/.git --work-tree=/repo push', '/repo'],
  ['git -C other push; echo done', '/repo/other'],
  ['git -C other push&& echo done', '/repo/other'],
  ['git -C other push|cat', '/repo/other'],
  ['(git -C other push)', '/repo/other'],
  ['git -C actual push || git -C actual push', '/repo/actual'],
  ['git -C actual push; git --work-tree=/repo/actual push', '/repo/actual'],
  ['git push && git push', undefined],
  ['git push || git -C /repo push', undefined],
  ['git -C /repo push || git push', '/repo'],
] as const) {
  test(`${command} looks up the branch in ${cwd ?? 'the session directory'}`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { branchPr: null })
    mock.env(on, { HOME: '/home/tester' })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
    await $.session.start(START)
    await clock.settle()
    w.branchPr = { url: URL, state: 'OPEN' }

    await $.tool.call({ tool: 'Bash', command })
    await clock.settle()
    const lookups = w.processRuns.filter((run) => run.argv[1] === 'pr')
    expect(lookups).toEqual([
      { argv: ['gh', 'pr', 'view', '--json', 'url,state'], init: undefined },
      { argv: ['gh', 'pr', 'view', '--json', 'url,state'], init: cwd === undefined ? undefined : { cwd } },
    ])
    expect(w.queries).toBe(1)
  })
}

for (const command of [
  'git -C "$WORKTREE" push',
  'git -C \'$WORKTREE\' push',
  'git -C `pwd` push',
  'git -C ~someone/other push',
  'git --work-tree="$WORKTREE" push',
  'git --work-tree `pwd` push',
  'git --work-tree ~someone/other push',
  'git -C "$WORKTREE" --work-tree=/other push',
  'git -C ~/other push',
  'git -C missing push || git -C actual push',
  'git push || git -C actual push',
  'git -C actual push || git push',
  'git -C actual push || git -C actual push || git -C other push',
  'git -C actual push || git -C "$WORKTREE" push',
  'git -C "$WORKTREE" push || git -C actual push',
]) {
  test(`${command} skips an unresolved or ambiguous directory lookup but still tracks the push`, async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    const w = stubWorld(on, { branchPr: null })
    mock.env(on, {})
    const pushed = '   a1a1a1a..b2b2b2b  feature -> feature\n'
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
    await $.session.start(START)
    await clock.settle()
    w.branchPr = { url: URL, state: 'OPEN' }
    w.pull.thumbsUpAt = NOW + 10_000

    await clock.advance(30_000)
    await $.tool.call({ tool: 'Bash', command })
    w.pull.head = 'b2b2b2b0123456789'
    await clock.advance(MINUTE)
    expect(w.branchLookups).toBe(1)
    expect(w.queries).toBe(0)

    await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
    await clock.settle()
    expect(w.queries).toBe(1)
    expect(w.prompts).toEqual([])
    expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ since: NOW + 30_000 })
  })
}

test('a failed lookup after git -C push retries in the same directory', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { branchPr: null })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()
  w.branchPr = 'error'

  await $.tool.call({ tool: 'Bash', command: 'git -C /repo/.wt/other push' })
  await clock.settle()
  w.branchPr = { url: URL, state: 'OPEN' }
  await clock.advance(MINUTE)
  const lookups = w.processRuns.filter((run) => run.argv[1] === 'pr')
  expect(lookups.map((run) => run.init)).toEqual([undefined, { cwd: '/repo/.wt/other' }, { cwd: '/repo/.wt/other' }])
  expect(w.queries).toBe(1)
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

test('taking back a review keeps the newer approval and sends the review again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let release = () => {}
  const w = stubWorld(on, {
    pull: { thumbsUpAt: NOW - MINUTE, reviews: [{ id: 1, at: NOW - 2 * MINUTE, comments: 1 }] },
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
  expect(w.prompts.length).toBe(3)
  expect(w.prompts[2]).toContain('レビュー 1 件')
  expect(w.prompts[2]).not.toContain('なお、このレビューの後')
  expect(w.store.get('pr:' + URL.toLowerCase())).toMatchObject({ reviews: ['1'], approvedAt: NOW + 30_000 })
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
  await ui.press({ key: `cleanup-${URL.toLowerCase()}` })
  await clock.settle()
  expect(w.prompts).toEqual([expect.stringContaining('未コミットの変更や push していないコミットが残っていないかを確かめ')])
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeDefined()
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

  w.branchPr = { url: 'https://github.com/HolyGrail/claude-mods/pull/9', state: 'OPEN' }
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

  w.branchPr = null
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

test('watching another pull request keeps the previous cleanup row until that pull request is watched again', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()
  w.pull.state = 'MERGED'
  await clock.advance(MINUTE)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeDefined()
  w.pull.state = 'OPEN'
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: 'https://github.com/HolyGrail/claude-mods/pull/9' })
  await clock.settle()
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeDefined()
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL })
  await clock.settle()
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeUndefined()
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
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL, since: iso(LAST_PUSH) })
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
  const w = stubWorld(on, { branchPr: 'error' })
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

test('a poll note carries the watch tool baseline from the start', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { answers: () => clock.sleep(10_000) })
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL, since: iso(LAST_PUSH) })
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
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL, since: iso(LAST_PUSH) })
  await clock.settle()
  expect(w.store.get(NOTE)).toMatchObject({ running: true })

  // The resumed conversation has no pull request to watch
  w.branchPr = null
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

test('a poll note is timed when it goes out, after reading its stored predecessor', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  w.gets = async (key) => {
    if (key === NOTE) await clock.sleep(5_000)
  }
  w.answers = () => clock.sleep(10_000)
  await clock.advance(5_000)
  expect(w.store.get(NOTE)).toMatchObject({ at: NOW + 5_000, running: true })
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
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeUndefined()

  // The other session raised the toast and recorded the merge; this one learns it from the record
  w.store.set('pr:' + URL.toLowerCase(), { since: LAST_PUSH, head: null, approvedAt: 0, usageLimitAt: 0, reviews: [], ended: 'MERGED', at: NOW })
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual([])
  expect(w.posts).toEqual([])
  expect(w.status).toBe('PR #7 マージ済み')
  expect(await ui.find({ key: `cleanup-${URL.toLowerCase()}` })).toBeDefined()
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

test('a poll overtaken by a new watch while it waits for the session id writes no note', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()
  expect(w.store.get(NOTE)).toEqual({ pr: URL.toLowerCase(), at: NOW, since: LAST_PUSH })

  w.ids = () => clock.sleep(5_000)
  await clock.advance(MINUTE)
  // The session turns to another pull request while the poll still waits for the session id.
  w.ids = async () => {}
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
    const watchedBranch = (e as unknown as { command: string }).command.includes('feature')
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
  const w = stubWorld(on, { branchPr: null })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  // The pull request already existed with Codex's approval of its head; the push changes nothing
  w.branchPr = { url: URL, state: 'OPEN' }
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  await $.tool.call({ tool: 'Bash', command: 'git push -q origin HEAD' })
  // The poll the push starts asks GitHub in the millisecond the push ended, so it leaves the relay
  // to the next one
  await clock.advance(MINUTE)
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
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW + 5_000 }] })
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
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  w.gets = async (key) => {
    if (key === NOTE) await clock.sleep(20_000)
  }
  // The watch has begun, and its first poll still reads its stored note.
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
  expect(w.store.get(NOTE)).toMatchObject({ idle: true, pending: [{ at: NOW + 15_500 }] })
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
  // Codex reviewed after the head was committed, but before the push the watch tool supplies.
  const w = stubWorld(on, { pull: { committedAt: LAST_PUSH - 5 * MINUTE, reviews: [{ id: 1, at: LAST_PUSH - 2 * MINUTE, comments: 1 }] } })
  // This session's first poll leaves the round to another, so no record holds the push yet
  w.store.set('poll:session-a', pollNote(NOW - 1_000))
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: URL, since: iso(LAST_PUSH) })
  await clock.settle()
  expect(w.store.get(NOTE)).toMatchObject({ since: LAST_PUSH })

  // The watch starts over without supplying the baseline again.
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
  w.ids = () => clock.sleep(20_000)
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

test('a push started while the first poll reads its stored note is seen running at once', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(30_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  w.gets = async (key) => {
    if (key === NOTE) await clock.sleep(20_000)
  }
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
  w.ids = () => clock.sleep(20_000)
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
  // Once the head is known the push is timed again, just before Bash runs, and that goes out too
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW + 10_000, head: 'a1', running: true }] })
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
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(30_000)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  w.gets = async (key) => {
    if (key === NOTE) await clock.sleep(20_000)
  }
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

test('a merge whose record write lands past the lease is told on a later poll', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { state: 'MERGED' } })
  w.answers = () => clock.sleep(9 * MINUTE)
  await $.session.start(START)
  await clock.advance(1_000)
  let slow = true
  w.sets = async (key) => {
    if (slow && key.startsWith('pr:')) await clock.sleep(MINUTE)
  }
  await clock.advance(10 * MINUTE)
  expect(w.toasts).toEqual([])
  slow = false
  w.answers = async () => {}
  await clock.advance(2 * MINUTE)
  expect(w.toasts).toEqual(['PR #7 がマージされました'])
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
  w.branchPr = null
  w.ids = () => clock.sleep(10_000)
  await $.classic.SessionStart({ source: 'resume' })
  const turned = $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(1_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(MINUTE)
  await Promise.all([turned, push])
  expect(w.store.has(NOTE9)).toBe(false)
  expect(w.store.get('poll:session-c:' + PR9.toLowerCase())).toMatchObject({ pending: [{ at: NOW + 11_000 }] })
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
  // The other session learned of a newer push after this poll read the notes.
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

test('a module started afresh while its push still runs holds back the relay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1', reviews: [{ id: 1, at: NOW - 20_000, comments: 1 }] } })
  // The worker went while the Bash call it started went on
  w.store.set(NOTE, { ...pollNote(NOW - MINUTE), idle: true, pending: [{ id: 'p', at: NOW - 30_000, head: 'a1', running: true }] })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])
})

test('a push of another branch to the commit the pull request reached by itself does not count', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1a1a1a0123456789' } })
  const pushed = '   c3c3c3c..b2b2b2b  other -> other\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  // The pull request moved to b2 and Codex reviewed it before this session polled again
  w.pull.head = 'b2b2b2b0123456789'
  w.pull.reviews = [{ id: 1, at: NOW + 20_000, comments: 1 }]
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin other' })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
})

test('a deferral the store refuses stops the poll as failed', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  w.store.set('poll:session-a', { ...pollNote(NOW - 1_000), running: true })
  w.answers = async () => {
    w.noteError = 'store busy'
  }
  await $.session.start(START)
  await clock.settle()
  expect(w.status).toContain('poll note:')
})

test('a --porcelain push of another branch to the commit the pull request reached by itself does not count', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1a1a1a0123456789' } })
  const pushed = 'To github.com:HolyGrail/claude-mods.git\n \tHEAD:refs/heads/other\tc3c3c3c..b2b2b2b\nDone\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: pushed, stderr: '', interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  w.pull.head = 'b2b2b2b0123456789'
  w.pull.reviews = [{ id: 1, at: NOW + 20_000, comments: 1 }]
  await clock.advance(30_000)
  await $.tool.call({ tool: 'Bash', command: 'git push --porcelain origin other' })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
})

test('a Bash call whose last push was up to date still counts the push before it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1a1a1a0123456789' } })
  const pushed = '   a1a1a1a..b2b2b2b  feature -> feature\nEverything up-to-date\n'
  on('tool.call', { tool: 'Bash' }, () => {
    w.pull.head = 'b2b2b2b0123456789'
    return { result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed } as never
  })
  await $.session.start(START)
  await clock.settle()

  // Codex reviewed the old head just before the push
  w.pull.reviews = [{ id: 1, at: NOW + 5_000, comments: 1 }]
  await clock.advance(10_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD && git push --tags' })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
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
  const w = stubWorld(on, { branchPr: null })
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
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('approved')])
})

test('pruning leaves this session\'s note a watch took up while it was deciding', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { branchPr: null })
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
  const w = stubWorld(on, { branchPr: null })
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

test('a push whose Bash call hangs counts once the head moves after it stops holding the relays back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(30 * MINUTE)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  // Codex reviewed the head the push replaces, and the push moved it to an older commit
  w.pull.reviews = [{ id: 1, at: NOW + 5_000, comments: 1 }]
  await clock.advance(10_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.pull.head = 'b2b2b2b0123456789'
  await clock.advance(12 * MINUTE)
  expect(w.prompts).toEqual([])
  await clock.advance(20 * MINUTE)
  await push
})

test('a record head seen after the push started is not taken as the head before it', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  const pushed = '   a1a1a1a..b2b2b2b  feature -> feature\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  // The record cannot be read as the push starts, so the push knows no head before it
  w.pull.reviews = [{ id: 1, at: NOW + 5_000, comments: 1 }]
  await clock.advance(10_000)
  const record = 'pr:' + URL.toLowerCase()
  w.getFails = (key) => key === record
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.getFails = undefined
  // Another session sees the pushed head first
  w.pull.head = 'b2b2b2b0123456789'
  w.store.set(record, { ...(w.store.get(record) as object), head: 'b2b2b2b0123456789', headAt: NOW + 20_000 })
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
})

test('a record head seen in the same millisecond as this session\'s but different leaves the head before unknown', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  const pushed = '   a1a1a1a..b2b2b2b  other -> other\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  // Another session saw a different head in the very millisecond this one saw its own
  const record = 'pr:' + URL.toLowerCase()
  const seen = w.store.get(record) as { headAt: number }
  w.store.set(record, { ...seen, head: 'b2b2b2b0123456789' })
  w.pull.thumbsUpAt = NOW + 10_000
  await clock.advance(20_000)
  // A push of another branch to that commit is not the pull request's push
  await $.tool.call({ tool: 'Bash', command: 'git push origin other' })
  w.pull.head = 'b2b2b2b0123456789'
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([expect.stringContaining('approved')])
})

test('another session\'s stale note is kept while its pull request is open', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  w.store.set('pr:' + URL.toLowerCase(), { at: NOW - MINUTE, since: LAST_PUSH })
  w.store.set('poll:session-c', pollNote(NOW - 15 * 24 * 60 * MINUTE))
  await $.session.start(START)
  await clock.settle()
  expect(w.deleted).not.toContain('poll:session-c')
  expect(w.store.has('poll:session-c')).toBe(true)
})

test('a push counts from when its Bash call runs, even if its last note is slow to go out', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1a1a1a0123456789' } })
  const pushed = '   a1a1a1a..b2b2b2b  feature -> feature\n'
  on('tool.call', { tool: 'Bash' }, () => {
    w.pull.head = 'b2b2b2b0123456789'
    return { result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed } as never
  })
  await $.session.start(START)
  await clock.settle()

  // Each note write takes 10 s, so the push runs 30 s after it was asked for
  w.sets = async (key) => {
    if (key === NOTE) await clock.sleep(10_000)
  }
  await clock.advance(10_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  // Codex reviewed the old head while the last note went out
  w.pull.reviews = [{ id: 1, at: NOW + 35_000, comments: 1 }]
  await clock.advance(2 * MINUTE)
  await push
  w.sets = undefined
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
})

test('a poll that defers leaves a watch that began while its note went out alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pulls: { 9: { committedAt: LAST_PUSH - 5 * MINUTE, reviews: [{ id: 5, at: LAST_PUSH - 2 * MINUTE, comments: 1 }] } } })
  // Another session polls the same round a moment earlier, so this one defers
  w.store.set('poll:session-a', { ...pollNote(NOW - 1_000), running: true })
  let slow = false
  w.answers = async () => {
    slow = true
  }
  w.sets = async (key) => {
    if (slow && key === NOTE) await clock.sleep(10_000)
  }
  await $.session.start(START)
  await clock.advance(1_000)
  // The watch turns while the deferral is on its way to the store
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  w.answers = async () => {}
  slow = false
  await clock.advance(2 * MINUTE)
  // PR #7's head commit date is not PR #9's baseline.
  expect(w.prompts).toEqual([expect.stringContaining('レビュー 1 件')])
})

test('a push made after a fork, before the first poll, goes under the fork\'s id', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('classic.SessionStart', () => ({}))
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  w.sessionId = 'session-c'
  await $.classic.SessionStart({ source: 'fork' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(MINUTE)
  expect(w.store.get(NOTE)).not.toHaveProperty('pending')
  expect(w.store.get('poll:session-c:' + URL.toLowerCase())).toMatchObject({ pending: [{ at: NOW }] })
})

test('a push another session started and finished after GitHub answered holds back the relay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1a1a1a0123456789', reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  // Read first among the other notes, and slow, so the other session's push lands in between
  w.store.set('poll:session-c', { ...pollNote(NOW - 2 * MINUTE), idle: true })
  w.store.set('poll:session-a', { ...pollNote(NOW - 2 * MINUTE), idle: true })
  let once = true
  w.gets = async (key) => {
    if (key !== 'poll:session-c' || !once || !w.queries) return
    once = false
    await clock.sleep(5_000)
    w.pull.head = 'b2b2b2b0123456789'
    w.store.set('poll:session-a', {
      ...pollNote(NOW - 2 * MINUTE),
      idle: true,
      pending: [{ id: 'p', at: NOW + 1_000, head: 'a1a1a1a0123456789', shas: ['b2b2b2b'], doneAt: NOW + 2_000 }],
    })
  }
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])
  await clock.advance(MINUTE)
  // The push replaced the head the review was about
  expect(w.prompts).toEqual([])
})

test('a store that fails the startup prune still leaves the pull request watched', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  w.store.set('junk', 1)
  w.getFails = (key) => key === 'junk'
  await $.session.start(START)
  await clock.settle()
  expect(w.status).toBe('PR #7 監視中 · 21:00 確認')
})

test('a push whose last note is slow to go out is timed in its note as its Bash call runs', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    await clock.sleep(5 * MINUTE)
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start(START)
  await clock.settle()

  w.sets = async (key) => {
    if (key === NOTE) await clock.sleep(10_000)
  }
  await clock.advance(10_000)
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  // Bash runs from NOW + 40 s, after three slow writes; the fourth says so to the other sessions
  await clock.advance(45_000)
  expect(w.store.get(NOTE)).toMatchObject({ pending: [{ at: NOW + 40_000, running: true }] })
  w.sets = undefined
  await clock.advance(5 * MINUTE)
  await push
})

test('a merge whose toast a push took back is told on a later poll', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { state: 'MERGED' } })
  const record = 'pr:' + URL.toLowerCase()
  let once = true
  w.gets = async (key) => {
    if (key !== record || !once || !w.queries) return
    once = false
    // Another session starts a push while the record is read
    w.store.set('poll:session-a', { ...pollNote(NOW - 2 * MINUTE), idle: true, pending: [{ id: 'p', at: NOW, head: 'a1', running: true }] })
  }
  await $.session.start(START)
  await clock.settle()
  expect(w.toasts).toEqual([])
  expect(w.posts).toEqual([])

  // Its push moved nothing
  w.store.delete('poll:session-a')
  await clock.advance(MINUTE)
  expect(w.toasts).toEqual(['PR #7 がマージされました'])
  expect(w.posts).toEqual(['/notice main advanced (#7). Rebase before the next push.'])
})

test('a push another session starts during the last check of the notes holds back the relay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1', reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  w.store.set('poll:session-a', { ...pollNote(NOW - 2 * MINUTE), idle: true })
  let reads = 0
  w.gets = async (key) => {
    if (key !== 'poll:session-a' || !w.queries) return
    // Read once to elect and once once the record is written; the push starts right after that
    reads += 1
    if (reads === 2) w.store.set('poll:session-a', { ...pollNote(NOW - 2 * MINUTE), idle: true, pending: [{ id: 'p', at: NOW, head: 'a1', running: true }] })
  }
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])
})

test('a push that finished in the millisecond GitHub answered holds back the relay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1a1a1a0123456789', reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  w.store.set('poll:session-a', {
    ...pollNote(NOW - 2 * MINUTE),
    idle: true,
    pending: [{ id: 'p', at: NOW - 1_000, head: 'a1a1a1a0123456789', shas: ['b2b2b2b'], doneAt: NOW }],
  })
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])
})

test('a push run past its hold that finishes while the record is written holds back the relay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { head: 'a1', reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  const pending = { id: 'p', at: NOW - 11 * MINUTE, head: 'a1', running: true }
  w.store.set('poll:session-a', { ...pollNote(NOW - 2 * MINUTE), idle: true, pending: [pending] })
  const record = 'pr:' + URL.toLowerCase()
  let once = true
  w.gets = async (key) => {
    if (key !== record || !once || !w.queries) return
    once = false
    const { running, ...done } = pending
    w.store.set('poll:session-a', { ...pollNote(NOW - 2 * MINUTE), idle: true, pending: [{ ...done, doneAt: NOW, shas: ['b2b2b2b'] }] })
  }
  await $.session.start(START)
  await clock.settle()
  expect(w.prompts).toEqual([])
})

test('a push that started and finished while the record was read still holds back the relay', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  const record = 'pr:' + URL.toLowerCase()
  let slow = true
  w.gets = async (key) => {
    if (key === record && slow) {
      slow = false
      await clock.sleep(10_000)
    }
  }
  await clock.advance(MINUTE + 1_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(15_000)
  expect(w.prompts).toEqual([])
  w.gets = undefined
})

test('a poll yields to a note timed in the same millisecond while its own was on its way', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  // The next poll's note is slow to land, and a session whose key sorts after this one's starts its
  // poll in the same millisecond
  let writes = 0
  w.sets = async (key) => {
    if (key === NOTE && ++writes === 1) await clock.sleep(20_000)
  }
  await clock.advance(MINUTE)
  w.store.set('poll:session-z', pollNote(NOW + MINUTE))
  await clock.advance(25_000)
  expect(w.prompts).toEqual([])
})

test('a merge seen by a poll whose record lands past the lease raises no toast', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { state: 'MERGED' } })
  on('session.end', () => ({ sessionId: 'session-b' }))
  w.sets = async (key) => {
    if (key.startsWith('pr:')) await clock.sleep(10 * MINUTE)
  }
  await $.session.start(START)
  await clock.advance(10 * MINUTE + 1_000)
  expect(w.toasts).toEqual([])
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-b', resume: { id: 'session-b' } })
  w.sets = undefined
})

test('a usage limit seen before a push that started while the record was written raises no toast', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  w.pull.comments = [{ at: NOW + 30_000, body: 'You have reached your Codex usage limits for code reviews.' }]
  const record = 'pr:' + URL.toLowerCase()
  w.sets = async (key) => {
    if (key === record) await clock.sleep(10_000)
  }
  await clock.advance(MINUTE + 1_000)
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(15_000)
  expect(w.toasts).toEqual([])
  w.sets = undefined
})

test('a failed poll of the last pull request leaves the next one\'s status alone', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  // The next poll fails, and leaving its note idle is slow
  w.queryError = 'HTTP 502'
  let slow = false
  w.answers = async () => {
    slow = true
  }
  w.sets = async (key) => {
    if (key === NOTE && slow) {
      slow = false
      await clock.sleep(30_000)
    }
  }
  await clock.advance(MINUTE + 1_000)
  w.queryError = undefined
  // The next pull request's first poll is slow to hear from GitHub
  w.answers = () => clock.sleep(MINUTE)
  w.pulls = { 9: { head: 'c3c3c3c', branch: 'next' } }
  await $.tool.call({ tool: 'mcp__pr-relay__watch', pr_url: PR9 })
  await clock.advance(40_000)
  expect(w.status).not.toContain('HTTP 502')
  w.sets = undefined
  w.answers = async () => {}
  await clock.advance(MINUTE)
})

test('a mark the store will not take back is shown in the status line', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)
  await $.session.start(START)
  await clock.settle()

  w.pull.reviews = [{ id: 1, at: NOW + 30_000, comments: 1 }]
  const record = 'pr:' + URL.toLowerCase()
  let writes = 0
  w.sets = async (key) => {
    if (key === record && ++writes === 1) await clock.sleep(10_000)
  }
  await clock.advance(MINUTE + 1_000)
  // A push makes the poll take its mark back, and the store then refuses the record
  await $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  w.getFails = (key) => key === record
  await clock.advance(15_000)
  expect(w.prompts).toEqual([])
  expect(w.status).toContain('mark:')
  w.getFails = undefined
  w.sets = undefined
})

test('a final read of the notes that outlasts the lease takes its marks back for the next round', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on, { pull: { reviews: [{ id: 1, at: NOW - MINUTE, comments: 1 }] } })
  const other = 'poll:session-a:' + URL.toLowerCase()
  w.store.set(other, { ...pollNote(NOW - 5 * MINUTE), idle: true })
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
  w.sets = undefined
  w.gets = undefined
  await clock.advance(MINUTE)
  expect(w.prompts.length).toBe(1)
})

test('a push counts from when its Bash call runs, not from when its notes started going out', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  const pushed = '   a1a1a1a..b2b2b2b  feature -> feature\n'
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: pushed, interrupted: false }, text: pushed }) as never)
  await $.session.start(START)
  await clock.settle()

  // The head is slow to look up, and Codex reviews the old head meanwhile
  await clock.advance(10_000)
  w.gets = () => clock.sleep(20_000)
  w.pull.reviews = [{ id: 1, at: NOW + 20_000, comments: 1 }]
  const push = $.tool.call({ tool: 'Bash', command: 'git push origin HEAD' })
  await clock.advance(25_000)
  await push
  w.gets = undefined
  w.pull.head = 'b2b2b2b0123456789'
  await clock.advance(MINUTE)
  expect(w.prompts).toEqual([])
})

test('a poll that yields says so before the record is read', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const w = stubWorld(on)
  await $.session.start(START)
  await clock.settle()

  // Another session started its poll a moment before this one's next, and the record is slow
  const record = 'pr:' + URL.toLowerCase()
  await clock.advance(MINUTE - 1_000)
  w.store.set('poll:session-a', pollNote(NOW + MINUTE - 1_000))
  w.gets = async (key) => {
    if (key === record) await clock.sleep(20_000)
  }
  await clock.advance(5_000)
  expect(w.store.get(NOTE)).toMatchObject({ deferred: true })
  w.gets = undefined
  await clock.advance(20_000)
})

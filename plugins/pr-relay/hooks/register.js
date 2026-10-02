// Watches this session's pull request on a timer and wakes the session only when something
// changed: a merge, a Codex review, or Codex's thumbs-up. The model then never has to poll.

// How often to ask GitHub about the pull request. One GraphQL query a tick costs one point of the
// 5,000 an hour, so even a dozen sessions polling at once stay far below the limit.
const TICK_MS = 60_000
// Codex's login as GraphQL spells it (REST adds "[bot]")
const CODEX = 'chatgpt-codex-connector'
// Where the /dev skill keeps its sessions, under $HOME
const DEV_SESSIONS = '/.claude/dev-sessions'
// What this module has already relayed for a pull request lives under this prefix plus its URL, in
// $.store, so another session on the same pull request, or this one after a restart, is not woken
// again for the same event
const KEY_PREFIX = 'pr:'
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/
// What gh pr view says when the branch has no pull request, as opposed to failing to ask
const NO_PR = /no pull requests found/i
// The session.end reasons after which this module stops
const FINAL_REASONS = ['prompt_input_exit', 'other']

const HOUR_MS = 3_600_000
// Records untouched this long belong to pull requests nobody watches any more
const STALE_MS = 14 * 24 * HOUR_MS
// How a pull request that is no longer open reads
const ENDED = { MERGED: 'マージ', CLOSED: 'クローズ' }
// JST has no daylight saving time, so a fixed offset gives its clock
const JST_OFFSET_MS = 9 * HOUR_MS

// The newest events come last, and only those after the last push count, so the tail suffices
const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      headRefOid
      commits(last: 1) { nodes { commit { committedDate } } }
      reactionGroups { content reactors(last: 20) { edges { reactedAt node { ... on Bot { login } ... on User { login } } } } }
      reviews(last: 30) { nodes { databaseId submittedAt author { login } comments { totalCount } } }
      comments(last: 50) { nodes { createdAt author { login } body } }
    }
  }
}`

// The pull request this session watches: { url, owner, name, number, since, sessionFile, ended? },
// or null. since is the last push the watch started from; sessionFile the /dev session that
// named it, whose last_push_at moves on with each push the skill records.
let watched = null
// The timers that poll it, kept so the next watch or session.start can stop them
let timers = []
// Bumped by every watch and stop, so a poll or a lookup started before leaves the state alone
let generation = 0
// The last poll: { at, error? }, for the status line
let lastCheck = null
// Whether the band offers to clean up after the watched pull request's merge
let offersCleanup = false
// When this session last ran git push. It becomes the baseline only once the pull request's head
// has moved, since a push that changed nothing ("Everything up-to-date", another branch) must not
// hide the events that came before it.
let pushedAt = 0

export function register(on) {
  // Fires again on an enable or a worker respawn, which may keep this module's variables
  on('session.start', async ($, e, next) => {
    stop()
    watched = null
    lastCheck = null
    offersCleanup = false
    pushedAt = 0
    await $.tool.register({
      name: 'watch',
      description:
        'pr-relay polls a pull request for this session and sends a prompt when it is merged, when Codex ' +
        'reviews it, or when Codex gives it a thumbs-up. While it watches, do not poll for those yourself ' +
        '(sleep loops, poll-codex-review.sh --watch, ScheduleWakeup): end the turn and wait to be woken. ' +
        'Without arguments, returns what it watches. With pr_url, watches that pull request; since (ISO ' +
        '8601) is the last push, and only Codex activity after it counts.',
      inputSchema: {
        type: 'object',
        properties: {
          pr_url: { type: 'string', description: 'https://github.com/<owner>/<repo>/pull/<number>' },
          since: { type: 'string', description: 'The last push, ISO 8601' },
        },
      },
    })
    // Finding the pull request runs gh, so it starts once the session is ready rather than delaying it
    timers.push($.clock.after(0, () => discover($)))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (FINAL_REASONS.includes(e.reason)) stop()
    return next(e)
  })

  on('tool.call', { tool: 'mcp__pr-relay__watch' }, async ($, e) => {
    if (typeof e.pr_url === 'string') {
      if (!PR_URL.test(e.pr_url)) return { result: `Not a pull request URL: ${e.pr_url}` }
      const since = typeof e.since === 'string' ? Date.parse(e.since) : NaN
      watch($, { url: e.pr_url, since: Number.isNaN(since) ? 0 : since })
    }
    return { result: describe() }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command ?? ''
    // A stopgap until the /dev skill's Phase 5.5 ends the turn after a push by itself: its waiting
    // loop would otherwise poll for what this module already watches
    if (watched && !watched.ended && /poll-codex-review\.sh/.test(command) && /--watch\b/.test(command)) {
      return {
        deny:
          `pr-relay is watching ${watched.url} and will send a prompt when Codex reviews it, approves it ` +
          'or it is merged. End the turn instead of waiting here.',
      }
    }
    // Best effort: a push or a pull request made any other way is caught by the head commit's date,
    // the /dev session file and session.start
    const creates = /\bgh\s+pr\s+create\b/.test(command)
    const pushes = !creates && /\bgit\s+push\b/.test(command)
    if (!creates && !pushes) return next(e)
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    if (creates) {
      const url = ran.text?.match(PR_URL)?.[0]
      if (url) watch($, { url, since: startedAt })
    } else {
      // Codex reviews what was pushed, so its earlier activity says nothing about this push
      pushedAt = startedAt
      if (!watched) timers.push($.clock.after(0, () => discover($, { branchOnly: true })))
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!offersCleanup || !watched) return next(e)
    const elements = $.ui.resolve(e)
    const { url, number } = watched
    const close = () => {
      offersCleanup = false
      $.ui.invalidate('ui.render')
    }
    const line = elements.Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        elements.Text({ children: [`PR #${number} がマージされました`] }),
        elements.Button({
          key: 'cleanup',
          label: 'cleanup',
          variant: 'primary',
          onPress: () => {
            close()
            submit($, `PR ${url} がマージされました。/dev cleanup の手順で worktree とブランチを片付けてください。`)
          },
        }),
        elements.Button({ key: 'dismiss', label: '閉じる', role: 'dismiss', onPress: close }),
      ],
    })
    // Keep what the mods after this one draw in the band
    const rest = await next(e)
    if (!rest) return line
    return elements.Box({ flexDirection: 'column', children: [line, rest] })
  })
}

// Looks for the pull request to watch, and asks again a tick later when gh could not answer
async function discover($, { branchOnly = false } = {}) {
  if (watched) return
  const gen = generation
  if (!branchOnly) await prune($)
  const found = (branchOnly ? null : await findInDevSessions($)) ?? (await findForBranch($))
  if (watched || gen !== generation) return
  if (found) watch($, found)
  else if (found === undefined) timers.push($.clock.after(TICK_MS, () => discover($, { branchOnly })))
}

// Starts watching. The first poll runs on the clock, never inside the caller's hook: a prompt it
// submits starts its turn only once the session is idle, which a tool call still running is not.
function watch($, { url, since, sessionFile = null }) {
  stop()
  const gen = generation
  const pr = parse(url)
  // A push still waiting for its head to move belongs to the pull request watched before; with
  // none watched, it is the push that led here
  if (watched && watched.id !== pr.id) pushedAt = 0
  watched = { ...pr, since, sessionFile }
  offersCleanup = false
  // Ask at once: a review or a merge may have come while no session watched
  timers.push($.clock.after(0, () => poll($, gen)))
  timers.push($.clock.every(TICK_MS, () => poll($, gen)))
}

function stop() {
  for (const timer of timers) timer?.cancel()
  timers = []
  generation += 1
}

async function poll($, gen) {
  if (gen !== generation || !watched || watched.ended) return
  const pr = watched
  const key = KEY_PREFIX + pr.id
  const now = await $.clock.now()
  // /dev writes the session's pr_url only after the pull request exists, so a watch that began
  // before (gh pr create, the watch tool) looks for its file until one names it
  const sessionFile = pr.sessionFile ?? (await findSessionFile($, pr.id))
  const [answer, stored, recordedPush] = await Promise.all([
    query($, pr).then((data) => ({ data }), (error) => ({ error })),
    $.store.get(key),
    lastPushOf($, sessionFile),
  ])
  // A watch that began meanwhile owns the state now
  if (gen !== generation) return
  if (answer.error) {
    lastCheck = { at: now, error: String(answer.error?.message ?? answer.error) }
    showStatus($)
    return
  }
  const { data } = answer
  lastCheck = { at: now }
  if (sessionFile) watched = { ...watched, sessionFile }
  const ended = data.state === 'MERGED' || data.state === 'CLOSED'
  if (ended) {
    stop()
    watched = { ...watched, ended: data.state }
    if (data.state === 'MERGED') {
      offersCleanup = true
      $.ui.invalidate('ui.render')
    }
  }

  const record = normalize(stored)
  const sends = update($, pr, data, record, recordedPush)
  record.at = now
  await $.store.set(key, record)
  // Only once the record says they were relayed, so a send that fails can take its mark back. A
  // watch that began during the write (an ended pull request stopped the timers itself) takes
  // the marks back instead, and a later watch of this pull request sends them.
  const current = gen === generation || ended
  for (const send of sends) current ? deliver($, key, send) : takeBack($, key, send.undo)
  showStatus($)
}

// Brings the record up to the pull request's state, and returns the prompts to send for what is new
function update($, pr, data, record, recordedPush) {
  // Codex reviews pushes, so only its activity after the latest push counts. The thumbs-up in
  // particular is one reaction per pull request whose time can stay at an earlier push: its mere
  // presence would read as an approval of every later push.
  const committedAt = Date.parse(data.commits?.nodes?.[0]?.commit?.committedDate ?? '') || 0
  record.since = Math.max(record.since, pr.since, recordedPush, committedAt)
  if (pushedAt && data.headRefOid !== record.head) {
    record.since = Math.max(record.since, pushedAt)
    pushedAt = 0
  }
  record.head = data.headRefOid ?? record.head
  if (data.state === 'MERGED' || data.state === 'CLOSED') {
    if (!record.ended) {
      record.ended = data.state
      $.ui.toast(`PR #${pr.number} が${ENDED[data.state]}されました`)
    }
    return []
  }
  // A reopened pull request ends again, and that end is news again
  record.ended = null
  return relay($, pr, read(data, record.since), record)
}

// Marks what is new since the last push as relayed, in poll-codex-review.sh's order: an approval,
// then a review, then the usage limit. Returns each prompt to send with how to take its mark back.
function relay($, pr, signals, record) {
  const fresh = signals.reviews.filter((r) => !record.reviews.includes(r.id))
  if (signals.approvedAt > record.approvedAt) {
    const approvedAt = signals.approvedAt
    const previous = record.approvedAt
    record.approvedAt = approvedAt
    // A review the approval came after is settled by it; a later one still waits its turn
    const settled = fresh.filter((r) => r.at <= approvedAt).map((r) => r.id)
    record.reviews.push(...settled)
    return [
      {
        text:
          `Codex が PR #${pr.number} (${pr.url}) を approved にしました（${clock(approvedAt)}）。` +
          'CI の結果を確かめ、完了報告と ~/.claude/dev-sessions のセッションファイルの更新をしてください。',
        // A newer approval recorded since keeps both its time and the reviews it settles
        undo: (r) => {
          if (r.approvedAt !== approvedAt) return
          r.approvedAt = previous
          r.reviews = r.reviews.filter((id) => !settled.includes(id))
        },
      },
    ]
  }
  if (fresh.length > 0) {
    record.reviews.push(...fresh.map((r) => r.id))
    const comments = fresh.reduce((sum, r) => sum + r.comments, 0)
    return [
      {
        text:
          `Codex が PR #${pr.number} (${pr.url}) にレビューを付けました（レビュー ${fresh.length} 件、` +
          `inline コメント ${comments} 件）。/dev の Phase 5.5 の手順で指摘を triage し、対応してください。`,
        // A review an approval recorded since came after stays settled by it
        undo: (r) => {
          const pending = fresh.filter((f) => f.at > r.approvedAt).map((f) => f.id)
          r.reviews = r.reviews.filter((id) => !pending.includes(id))
        },
      },
    ]
  }
  if (signals.usageLimitAt > record.usageLimitAt) {
    record.usageLimitAt = signals.usageLimitAt
    $.ui.toast(`PR #${pr.number}: Codex の利用上限に達し、レビューが付きません`)
  }
  return []
}

// Queues a prompt without waiting for it, since it resolves only when its turn starts. A prompt
// that did not enter (refused, or dropped by a hook) takes its mark back, so a later poll sends it.
function deliver($, key, { text, undo }) {
  submit($, text).then((entered) => entered || takeBack($, key, undo))
}

async function takeBack($, key, undo) {
  const record = normalize(await $.store.get(key))
  undo(record)
  await $.store.set(key, record)
}

// Whether the prompt entered the session
function submit($, text) {
  return $.prompt.submit({ text }).then(
    (result) => result?.drop === undefined,
    () => false,
  )
}

// The Codex activity after since, as times in milliseconds
function read(data, since) {
  const after = (iso) => {
    const at = Date.parse(iso ?? '')
    return at > since ? at : 0
  }
  const byCodex = (node) => node?.login === CODEX
  let approvedAt = 0
  for (const group of data.reactionGroups ?? []) {
    if (group.content !== 'THUMBS_UP') continue
    for (const edge of group.reactors?.edges ?? []) {
      if (byCodex(edge.node)) approvedAt = Math.max(approvedAt, after(edge.reactedAt))
    }
  }
  let usageLimitAt = 0
  for (const comment of data.comments?.nodes ?? []) {
    if (!byCodex(comment.author)) continue
    // The second form of an approval
    if (/Didn't find any major issues/i.test(comment.body)) approvedAt = Math.max(approvedAt, after(comment.createdAt))
    if (/reached your Codex usage limits/i.test(comment.body)) usageLimitAt = Math.max(usageLimitAt, after(comment.createdAt))
  }
  const reviews = (data.reviews?.nodes ?? [])
    .filter((r) => byCodex(r.author) && after(r.submittedAt) > 0)
    .map((r) => ({ id: r.databaseId, at: after(r.submittedAt), comments: r.comments?.totalCount ?? 0 }))
  return { approvedAt, usageLimitAt, reviews }
}

async function query($, pr) {
  const { exitCode, stdout, stderr } = await $.process.run([
    'gh', 'api', 'graphql',
    '-f', `query=${QUERY}`,
    // -f keeps a repository named like a number or a boolean a string; -F types the number
    '-f', `owner=${pr.owner}`,
    '-f', `name=${pr.name}`,
    '-F', `number=${pr.number}`,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim().split('\n')[0] || `gh exited ${exitCode}`)
  const data = JSON.parse(stdout)?.data?.repository?.pullRequest
  if (!data) throw new Error('pull request not found')
  return data
}

// The /dev session whose worktree holds this session's cwd, with an open pull request; the
// deepest worktree wins, so one nested in another repository's checkout is not taken for it
async function findInDevSessions($) {
  const [{ files, sessions }, cwd] = await Promise.all([readDevSessions($), $.session.cwd()])
  let best = null
  sessions.forEach((session, i) => {
    const root = session?.worktree_path?.replace(/\/+$/, '')
    if (!root || (cwd !== root && !cwd.startsWith(root + '/'))) return
    if (!best || root.length > best.root.length) best = { root, session, file: files[i] }
  })
  // The session that owns the cwd decides, even when it has no pull request yet
  const session = best?.session
  if (session?.status !== 'pr-open' || !PR_URL.test(session.pr_url ?? '')) return null
  return { url: session.pr_url, since: lastPush(session), sessionFile: best.file }
}

// The open pull request of the branch checked out here: null when there is none, undefined when gh
// could not tell
async function findForBranch($) {
  try {
    const ran = await $.process.run(['gh', 'pr', 'view', '--json', 'url,state'])
    if (ran.exitCode !== 0) return NO_PR.test(ran.stderr) ? null : undefined
    const { url, state } = JSON.parse(ran.stdout)
    return state === 'OPEN' && PR_URL.test(url) ? { url, since: 0 } : null
  } catch {
    return undefined
  }
}

// The /dev session file that names this pull request, or null
async function findSessionFile($, id) {
  const { files, sessions } = await readDevSessions($)
  const i = sessions.findIndex((session) => PR_URL.test(session?.pr_url ?? '') && parse(session.pr_url).id === id)
  return i < 0 ? null : files[i]
}

async function readDevSessions($) {
  const home = await $.env.get('HOME')
  if (!home) return { files: [], sessions: [] }
  const dir = home + DEV_SESSIONS
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries.filter((entry) => entry.kind === 'file' && entry.name.endsWith('.json')).map((entry) => `${dir}/${entry.name}`)
  return { files, sessions: await Promise.all(files.map((file) => readJson($, file))) }
}

// The last push the /dev session file records now
async function lastPushOf($, file) {
  return file ? lastPush(await readJson($, file)) : 0
}

function lastPush(session) {
  return Date.parse(session?.review?.last_push_at ?? '') || 0
}

function readJson($, file) {
  return $.fs
    .read(file)
    .then((text) => JSON.parse(text))
    .catch(() => null)
}

async function prune($) {
  const cutoff = (await $.clock.now()) - STALE_MS
  const keys = (await $.store.keys()).filter((key) => key.startsWith(KEY_PREFIX))
  await Promise.all(
    keys.map(async (key) => {
      const record = await $.store.get(key)
      if (!(record?.at >= cutoff)) await $.store.delete(key)
    }),
  )
}

function normalize(record) {
  return {
    since: record?.since ?? 0,
    head: record?.head ?? null,
    approvedAt: record?.approvedAt ?? 0,
    usageLimitAt: record?.usageLimitAt ?? 0,
    reviews: Array.isArray(record?.reviews) ? record.reviews : [],
    ended: record?.ended ?? null,
    at: record?.at ?? 0,
  }
}

// id is the pull request whatever the case it is spelled in, as GitHub reads owner and repository
// names: the store key, and what watches and session files are matched by
function parse(url) {
  const [whole, owner, name, number] = url.match(PR_URL)
  return { url: whole, id: whole.toLowerCase(), owner, name, number: Number(number) }
}

function showStatus($) {
  if (!watched) return $.ui.status(undefined)
  const label = `PR #${watched.number}`
  if (watched.ended) return $.ui.status(`${label} ${ENDED[watched.ended]}済み`)
  if (lastCheck?.error) return $.ui.status(`${label} 確認失敗 ${clock(lastCheck.at)}: ${lastCheck.error}`)
  $.ui.status(`${label} 監視中 · ${clock(lastCheck?.at ?? 0)} 確認`)
}

function describe() {
  if (!watched) return 'pr-relay is not watching a pull request in this session.'
  if (watched.ended) return `pr-relay watched ${watched.url}, which is now ${watched.ended.toLowerCase()}.`
  const checked = lastCheck ? ` Last checked ${new Date(lastCheck.at).toISOString()}.` : ''
  return `pr-relay is watching ${watched.url} and will send a prompt when it changes.${checked}`
}

// HH:MM in JST
function clock(ms) {
  const d = new Date(ms + JST_OFFSET_MS)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

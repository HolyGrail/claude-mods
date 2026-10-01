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
// The session.end reasons after which this module stops
const FINAL_REASONS = ['prompt_input_exit', 'other']

const HOUR_MS = 3_600_000
// Records untouched this long belong to pull requests nobody watches any more
const STALE_MS = 14 * 24 * HOUR_MS
// A record is written when it changes, and at least this often so prune keeps it
const TOUCH_MS = HOUR_MS
// How a pull request that is no longer open reads
const ENDED = { MERGED: 'マージ', CLOSED: 'クローズ' }
// JST has no daylight saving time, so a fixed offset gives its clock
const JST_OFFSET_MS = 9 * HOUR_MS

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      commits(last: 1) { nodes { commit { committedDate } } }
      reactionGroups { content reactors(last: 20) { edges { reactedAt node { ... on Bot { login } ... on User { login } } } } }
      reviews(last: 30) { nodes { databaseId submittedAt author { login } comments { totalCount } } }
      comments(last: 50) { nodes { createdAt author { login } body } }
    }
  }
}`

// The pull request this session watches: { url, owner, name, number }, or null
let watched = null
// The timer that polls it, kept so a later session.start can stop it
let ticker = null
// The last poll: { at, error? }, for the status line
let lastCheck = null
// Whether the band offers to clean up after the watched pull request's merge
let offersCleanup = false
// A push this session made is a newer baseline than any file records; kept until the next poll
// stores it
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
    $.clock.after(0, async () => {
      await prune($)
      const found = (await findInDevSessions($)) ?? (await findForBranch($))
      if (found && !watched) await watch($, found.url, found.since)
    })
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
      await watch($, e.pr_url, Number.isNaN(since) ? 0 : since)
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
    // Best effort: a push or a pull request made any other way is caught by the head commit's date
    // and by session.start
    const creates = /\bgh\s+pr\s+create\b/.test(command)
    const pushes = !creates && /\bgit\s+push\b/.test(command)
    if (!creates && !pushes) return next(e)
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    if (creates) {
      const url = ran.text?.match(PR_URL)?.[0]
      if (url) await watch($, url, startedAt)
    } else {
      // Codex reviews what was pushed, so its earlier activity says nothing about this push
      pushedAt = startedAt
      if (!watched) {
        const found = await findForBranch($)
        if (found) await watch($, found.url, startedAt)
      }
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
          onPress: async () => {
            close()
            await $.prompt.submit({
              text: `PR ${url} がマージされました。/dev cleanup の手順で worktree とブランチを片付けてください。`,
            })
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

async function watch($, url, since) {
  const pr = parse(url)
  stop()
  watched = pr
  offersCleanup = false
  pushedAt = Math.max(pushedAt, since)
  // Ask at once: a review or a merge may have come while no session watched
  await poll($)
  if (watched?.url === pr.url && !watched.ended) ticker = $.clock.every(TICK_MS, () => poll($))
}

function stop() {
  ticker?.cancel()
  ticker = null
}

async function poll($) {
  if (!watched) return
  const pr = watched
  const key = KEY_PREFIX + pr.url
  const now = await $.clock.now()
  const [answer, stored] = await Promise.all([query($, pr).then((data) => ({ data }), (error) => ({ error })), $.store.get(key)])
  if (answer.error) {
    lastCheck = { at: now, error: String(answer.error?.message ?? answer.error) }
    showStatus($)
    return
  }
  const { data } = answer
  lastCheck = { at: now }
  const record = normalize(stored)
  const before = JSON.stringify(record)
  // Codex reviews pushes, so only its activity after the latest push counts. The thumbs-up in
  // particular is one reaction per pull request whose time can stay at an earlier push: its mere
  // presence would read as an approval of every later push.
  const committedAt = Date.parse(data.commits?.nodes?.[0]?.commit?.committedDate ?? '') || 0
  record.since = Math.max(record.since, pushedAt, committedAt)
  pushedAt = 0

  if (data.state === 'MERGED' || data.state === 'CLOSED') {
    stop()
    watched = { ...pr, ended: data.state }
    if (data.state === 'MERGED') {
      offersCleanup = true
      $.ui.invalidate('ui.render')
    }
    if (!record.ended) {
      record.ended = data.state
      $.ui.toast(`PR #${pr.number} が${ENDED[data.state]}されました`)
    }
  } else {
    await relay($, pr, read(data, record.since), record)
  }
  if (JSON.stringify(record) !== before || now - record.at >= TOUCH_MS) {
    record.at = now
    await $.store.set(key, record)
  }
  showStatus($)
}

// Wakes the session for what is new since the last push, in poll-codex-review.sh's order: an
// approval, then a review, then the usage limit. Each event is relayed once.
async function relay($, pr, signals, record) {
  const fresh = signals.reviews.filter((r) => !record.reviews.includes(r.id))
  // A review the approval came after is settled by it, so either way it is relayed
  record.reviews.push(...fresh.map((r) => r.id))
  if (signals.approvedAt > record.approvedAt) {
    record.approvedAt = signals.approvedAt
    await $.prompt.submit({
      text:
        `Codex が PR #${pr.number} (${pr.url}) を approved にしました（${clock(signals.approvedAt)}）。` +
        'CI の結果を確かめ、完了報告と ~/.claude/dev-sessions のセッションファイルの更新をしてください。',
    })
  } else if (fresh.length > 0) {
    const comments = fresh.reduce((sum, r) => sum + r.comments, 0)
    await $.prompt.submit({
      text:
        `Codex が PR #${pr.number} (${pr.url}) にレビューを付けました（レビュー ${fresh.length} 件、` +
        `inline コメント ${comments} 件）。/dev の Phase 5.5 の手順で指摘を triage し、対応してください。`,
    })
  } else if (signals.usageLimitAt > record.usageLimitAt) {
    record.usageLimitAt = signals.usageLimitAt
    $.ui.toast(`PR #${pr.number}: Codex の利用上限に達し、レビューが付きません`)
  }
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
    .map((r) => ({ id: r.databaseId, comments: r.comments?.totalCount ?? 0 }))
  return { approvedAt, usageLimitAt, reviews }
}

async function query($, pr) {
  const { exitCode, stdout, stderr } = await $.process.run([
    'gh', 'api', 'graphql',
    '-f', `query=${QUERY}`,
    '-F', `owner=${pr.owner}`,
    '-F', `name=${pr.name}`,
    '-F', `number=${pr.number}`,
  ])
  if (exitCode !== 0) throw new Error(stderr.trim().split('\n')[0] || `gh exited ${exitCode}`)
  const data = JSON.parse(stdout)?.data?.repository?.pullRequest
  if (!data) throw new Error('pull request not found')
  return data
}

// The /dev session whose worktree this session runs in, with an open pull request
async function findInDevSessions($) {
  const [home, cwd] = await Promise.all([$.env.get('HOME'), $.session.cwd()])
  if (!home) return null
  const dir = home + DEV_SESSIONS
  const entries = await $.fs.list(dir).catch(() => [])
  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.json'))
      .map((entry) =>
        $.fs
          .read(`${dir}/${entry.name}`)
          .then((text) => JSON.parse(text))
          .catch(() => null),
      ),
  )
  for (const session of sessions) {
    const root = session?.worktree_path?.replace(/\/+$/, '')
    if (session?.status !== 'pr-open' || !PR_URL.test(session.pr_url ?? '') || !root) continue
    if (cwd !== root && !cwd.startsWith(root + '/')) continue
    return { url: session.pr_url, since: Date.parse(session.review?.last_push_at ?? '') || 0 }
  }
  return null
}

// The open pull request of the branch checked out here
async function findForBranch($) {
  try {
    const ran = await $.process.run(['gh', 'pr', 'view', '--json', 'url,state'])
    if (ran.exitCode !== 0) return null
    const { url, state } = JSON.parse(ran.stdout)
    return state === 'OPEN' && PR_URL.test(url) ? { url, since: 0 } : null
  } catch {
    return null
  }
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
    approvedAt: record?.approvedAt ?? 0,
    usageLimitAt: record?.usageLimitAt ?? 0,
    reviews: Array.isArray(record?.reviews) ? record.reviews : [],
    ended: record?.ended ?? null,
    at: record?.at ?? 0,
  }
}

function parse(url) {
  const [whole, owner, name, number] = url.match(PR_URL)
  return { url: whole, owner, name, number: Number(number) }
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

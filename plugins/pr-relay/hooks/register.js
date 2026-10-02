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
// Each session notes under this prefix plus its id and the pull request's when it last started a
// poll of it, as { pr, at, since, pending?, running?, idle? }, so sessions polling the same pull
// request together let only the first of them relay. since is the last push the session knows of,
// which the session that relays takes from it, and pending a push it ran that counts once the head
// has moved, { at, head } with the head it last saw;
// running stays set until the poll has written what it relayed; idle marks a note whose session
// stopped polling, kept only for its since. A session writes only its own key, since $.store has
// no atomic update.
const POLL_PREFIX = 'poll:'
// Polls of one pull request that started this close together are one round: the one that started
// first relays what is new, and the others leave it to that one. The query a poll waits on takes
// far longer than a store write, so each of them sees the earlier one's note by the time it reads.
const ROUND_MS = 30_000
// A poll still running holds back the later ones of other sessions past its round, since it has not
// written what it relayed yet; one this old is taken to belong to a session that died mid-poll
const RUNNING_MS = 10 * 60_000
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/
// What gh pr view says when the branch has no pull request, as opposed to failing to ask
const NO_PR = /no pull requests found/i
// The session.end reasons after which this module stops
const FINAL_REASONS = ['prompt_input_exit', 'other']

const HOUR_MS = 3_600_000
// Records of pull requests that ended and are untouched this long are of no more use. One left
// open keeps what was relayed for it far longer, since a session that finds it again would
// otherwise be woken for the same events.
const STALE_MS = 14 * 24 * HOUR_MS
const OPEN_STALE_MS = 90 * 24 * HOUR_MS
// Events are paged back only to the previous poll of the same watch, less this much
const PAGE_OVERLAP_MS = 5 * 60_000
// How a pull request that is no longer open reads
const ENDED = { MERGED: 'マージ', CLOSED: 'クローズ' }
// JST has no daylight saving time, so a fixed offset gives its clock
const JST_OFFSET_MS = 9 * HOUR_MS

// The newest events come last, and only those after the last push count. A page holds 100, the
// most GraphQL gives; a connection whose oldest item on it is still after the push is followed
// back a page at a time, up to MAX_PAGES.
const PAGE = 'last: 100, before: $before'
const PAGE_INFO = 'pageInfo { hasPreviousPage startCursor }'
const CONNECTIONS = {
  reactors: `reactionGroups { content reactors(${PAGE}) { ${PAGE_INFO} edges { reactedAt node { ... on Bot { login } ... on User { login } } } } }`,
  reviews: `reviews(${PAGE}) { ${PAGE_INFO} nodes { databaseId submittedAt author { login } comments { totalCount } } }`,
  comments: `comments(${PAGE}) { ${PAGE_INFO} nodes { createdAt author { login } body } }`,
}
const MAX_PAGES = 10
const queryOf = (fields) => `query($owner: String!, $name: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${fields} } }
}`
const QUERY = queryOf(`state headRefOid commits(last: 1) { nodes { commit { committedDate } } } ${Object.values(CONNECTIONS).join(' ')}`)

// The pull request this session watches: { url, id, owner, name, number, since, sessionFile,
// pagedAt?, ended? },
// or null. since is the last push the watch started from; sessionFile the /dev session that
// named it, whose last_push_at moves on with each push the skill records.
let watched = null
// The timers that poll it, kept so the next watch or session.start can stop them
let timers = []
// Bumped by every watch and stop, so a poll or a lookup started before leaves the state alone
let generation = 0
// The last poll: { at, error? }, for the status line
let lastCheck = null
// The last lookup of the pull request when gh could not answer it, { at, error }, for the status line
let lookupFailure = null
// The generation of the poll running now, so a tick that comes while one still waits on GitHub
// leaves it its note rather than overwriting it with a later round's
let polling = null
// The last push this session knows of for the watched pull request, which its poll note carries
let knownSince = 0
// The head of the watched pull request as this session's last poll found it
let lastHead = null
// This session's latest poll note, { key, pr, at, since, pending, running, serial }, as last written,
// so an older poll does not mark it finished, a push can update it and a stop can leave it idle
let lastNote = null
// The note a stop left idle, which a push that finishes later still updates
let idleNote = null
// Tells apart the polls of one session, which may share a key and a time
let noteSerial = 0
// Whether the band offers to clean up after the watched pull request's merge
let offersCleanup = false
// When this session last ran git push. It becomes the baseline only once the pull request's head
// has moved, since a push that changed nothing ("Everything up-to-date", another branch) must not
// hide the events that came before it.
let pushedAt = 0
// git push calls still running. While one is, what Codex said may be about the head it replaces,
// so nothing is relayed until it ends.
let pushesRunning = 0
// The read, change and write of a record in this session, one after another: a poll and a send
// that takes its mark back would otherwise each write what they read before the other wrote
let writes = Promise.resolve()

export function register(on) {
  // Fires again on an enable or a worker respawn, which may keep this module's variables
  on('session.start', async ($, e, next) => {
    stop()
    await retire($)
    reset($)
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
    if (FINAL_REASONS.includes(e.reason)) {
      stop()
      await retire($)
    }
    return next(e)
  })

  // /resume can turn this process to another conversation without a new session.start, and that
  // conversation may belong to another worktree and pull request
  on('classic.SessionStart', { source: ['resume'] }, async ($, e, next) => {
    stop()
    await retire($)
    reset($)
    timers.push($.clock.after(0, () => discover($)))
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
    // The /dev skill's Phase 5.5 ends the turn after a push when the watch tool is there; this
    // stops a session that polls anyway (an older copy of the skill, or a model off its steps)
    // from watching what this module already watches
    if (watched && !watched.ended && runsWatch(command)) {
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
    // Codex reviews what was pushed, so its earlier activity says nothing about this push. The time
    // is set before the push runs, so a poll that sees the new head while it is still finishing
    // already applies it, and put back if the push failed.
    const before = pushedAt
    if (pushes) {
      pushedAt = startedAt
      pushesRunning += 1
      await refreshNote($)
    }
    let ran
    try {
      ran = await next(e)
    } finally {
      if (pushes) pushesRunning -= 1
    }
    if (ran.deny !== undefined || ran.isError) {
      if (pushes && pushedAt === startedAt) {
        pushedAt = before
        await refreshNote($)
      }
      return ran
    }
    // The other sessions hold back their relays only while the push runs
    if (pushes) await refreshNote($)
    if (creates) {
      const url = ran.text?.match(PR_URL)?.[0]
      if (url) watch($, { url, since: startedAt })
    } else {
      if (!watched || watched.ended) timers.push($.clock.after(0, () => discover($, { branchOnly: true })))
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
            const text = `PR ${url} がマージされました。/dev cleanup の手順で worktree とブランチを片付けてください。`
            // A prompt that did not enter leaves the button to press again
            if (!(await submit($, text)) && watched?.url === url) {
              offersCleanup = true
              $.ui.invalidate('ui.render')
            }
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

function reset($) {
  watched = null
  lastCheck = null
  lookupFailure = null
  offersCleanup = false
  pushedAt = 0
  showStatus($)
}

// Looks for the pull request to watch, and asks again a tick later when gh could not answer
async function discover($, { branchOnly = false } = {}) {
  if (watched && !watched.ended) return
  const gen = generation
  if (!branchOnly) await prune($)
  // A /dev session that owns the cwd but has no pull request yet answers false: its own gh pr
  // create starts the watch, not whatever the branch had before
  const owned = branchOnly ? null : await findInDevSessions($)
  const found = owned === false ? null : (owned ?? (await findForBranch($)))
  const at = await $.clock.now()
  if ((watched && !watched.ended) || gen !== generation) return
  if (found?.error !== undefined) {
    // Shown in place of the watch's line, or of the ended pull request's when a push looks again
    lookupFailure = { at, error: found.error }
    showStatus($)
    timers.push($.clock.after(TICK_MS, () => discover($, { branchOnly })))
    return
  }
  if (lookupFailure) {
    lookupFailure = null
    showStatus($)
  }
  if (found) watch($, found)
}

// Starts watching. The first poll runs on the clock, never inside the caller's hook: a prompt it
// submits starts its turn only once the session is idle, which a tool call still running is not.
function watch($, { url, since, sessionFile = null }) {
  stop()
  const gen = generation
  const pr = parse(url)
  // A push still waiting for its head to move belongs to the pull request watched before; with
  // none watched, or the one watched ended, it is the push that led here
  if (watched && !watched.ended && watched.id !== pr.id) pushedAt = 0
  watched = { ...pr, since, sessionFile }
  lookupFailure = null
  knownSince = 0
  lastHead = null
  // The band may still offer the cleanup of the pull request watched before
  if (offersCleanup) {
    offersCleanup = false
    $.ui.invalidate('ui.render')
  }
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
  if (polling === gen) return
  polling = gen
  try {
    await pollOnce($, gen)
  } finally {
    if (polling === gen) polling = null
  }
}

async function pollOnce($, gen) {
  if (gen !== generation || !watched || watched.ended) return
  const pr = watched
  const key = KEY_PREFIX + pr.id
  // /dev writes the session's pr_url only after the pull request exists, so a watch that began
  // before (gh pr create, the watch tool) looks for its file until one names it
  const sessionFile = pr.sessionFile ?? (await findSessionFile($, pr.id))
  const recordedPush = await lastPushOf($, sessionFile)
  // Read just before the note goes out, since the time is this poll's place in the election
  const now = await $.clock.now()
  // What an earlier poll of this watch paged through is not asked for again
  const floor = Math.max(pr.since, recordedPush, (pr.pagedAt ?? 0) - PAGE_OVERLAP_MS)
  // Noted before asking, so a session that starts polling while this one waits on GitHub finds it,
  // with the pushes known already, so a session that relays before this one finishes counts them
  knownSince = Math.max(knownSince, pr.since, recordedPush)
  // A poll the other sessions cannot see would relay beside the one they elect, so it waits a tick
  const note = await notePoll($, pr, now).catch((error) => {
    lastCheck = { at: now, error: `poll note: ${error?.message ?? error}` }
    showStatus($)
    return null
  })
  if (!note) return
  try {
    await pollNoted($, gen, { pr, key, now, sessionFile, recordedPush, floor, note })
  } finally {
    await finishNote($, note)
  }
}

async function pollNoted($, gen, { pr, key, now, sessionFile, recordedPush, floor, note }) {
  const answer = await query($, pr, floor).then((data) => ({ data }), (error) => ({ error }))
  // A watch that began meanwhile owns the state now
  if (gen !== generation) return
  if (answer.error) {
    // A poll that learned nothing relays nothing, so it must not hold back the others' this round,
    // but the push it knows of still counts
    await retire($)
    lastCheck = { at: now, error: String(answer.error?.message ?? answer.error) }
    showStatus($)
    return
  }
  const { data } = answer
  // Another session polling this pull request in the same round, ahead of this one, relays what is
  // new; this one leaves the record to it and passes on what it knows through its note
  // Notes it could not read may hold an earlier poll, so this one then learned nothing either
  const notes = await readNotes($, pr, note).catch((error) => ({ error }))
  if (gen !== generation) return
  if (notes.error) {
    await retire($)
    lastCheck = { at: now, error: `poll notes: ${notes.error?.message ?? notes.error}` }
    showStatus($)
    return
  }
  const { defers, since: othersSince, pending, pushing } = notes
  lastHead = data.headRefOid ?? lastHead
  lastCheck = { at: now }
  watched = { ...watched, pagedAt: now, ...(sessionFile ? { sessionFile } : {}) }
  // One that leaves the waking to another session leaves the end to it too, and sees it next round
  // from the record, as the session that relays: only then does it stop and offer the cleanup
  const ended = !defers && (data.state === 'MERGED' || data.state === 'CLOSED')
  if (ended) {
    stop()
    watched = { ...watched, ended: data.state }
    if (data.state === 'MERGED') {
      offersCleanup = true
      $.ui.invalidate('ui.render')
    }
  }

  const sends = await exclusive(async () => {
    const record = normalize(await $.store.get(key))
    // A watch that began while this waited its turn owns pushedAt and the marks now
    if (gen !== generation && !ended) return null
    const sends = update($, pr, data, record, recordedPush, Math.max(othersSince, knownSince), pending, defers, pushing)
    // The session that relays writes the record at about this moment, so a copy read before its
    // marks must not land over them: one that leaves it the waking writes only its own note
    knownSince = Math.max(knownSince, record.since)
    if (defers) return sends
    record.at = now
    await $.store.set(key, record)
    return sends
  })
  if (sends === null) return
  // Only once the record says they were relayed, so a send that fails can take its mark back. A
  // watch that began during the write (an ended pull request stopped the timers itself) takes
  // the marks back instead, and a later watch of this pull request sends them.
  const current = gen === generation || ended
  for (const send of sends) current ? deliver($, key, send) : takeBack($, key, send.undo)
  showStatus($)
}

// Brings the record up to the pull request's state, and returns the prompts to send for what is new
function update($, pr, data, record, recordedPush, notedPush, pending, defers, pushing) {
  // Codex reviews pushes, so only its activity after the latest push counts. The thumbs-up in
  // particular is one reaction per pull request whose time can stay at an earlier push: its mere
  // presence would read as an approval of every later push.
  const committedAt = Date.parse(data.commits?.nodes?.[0]?.commit?.committedDate ?? '') || 0
  record.since = Math.max(record.since, pr.since, recordedPush, committedAt, notedPush)
  if (pushedAt && data.headRefOid !== record.head) {
    record.since = Math.max(record.since, pushedAt)
    pushedAt = 0
  }
  // Another session's push counts by the same rule, against the head that session last saw; one
  // that saw none yet cannot tell a push that moved nothing from one that did, so it waits for that
  // session's own poll
  for (const push of pending) {
    if (push.head != null && data.headRefOid !== push.head) record.since = Math.max(record.since, push.at)
  }
  record.head = data.headRefOid ?? record.head
  if (data.state === 'MERGED' || data.state === 'CLOSED') {
    if (!record.ended && !defers) {
      record.ended = data.state
      $.ui.toast(`PR #${pr.number} が${ENDED[data.state]}されました`)
    }
    return []
  }
  // A reopened pull request ends again, and that end is news again
  record.ended = null
  // A push running in any session may be replacing the head GitHub still shows
  return pushesRunning > 0 || pushing || defers ? [] : relay($, pr, read(data, record.since), record)
}

// Notes that this session starts a poll of the pull request now, and returns the note
async function notePoll($, pr, at) {
  // One note per pull request, so a session that turns to another leaves this one's push behind
  const key = `${POLL_PREFIX}${await $.session.id()}:${pr.id}`
  // The note under the id before /clear or /resume would read as another session's poll
  if (lastNote && lastNote.key !== key) await retire($)
  lastNote = { key, pr: pr.id, at, since: knownSince, pending: pendingPush(), running: true, serial: ++noteSerial }
  idleNote = null
  await writeNote($, lastNote, { strict: true })
  return { ...lastNote }
}

// Marks the note of a poll that has written what it relayed as finished, with what it now knows
async function finishNote($, note) {
  if (lastNote?.serial !== note.serial) return
  catchUp(lastNote)
  lastNote.running = false
  await writeNote($, lastNote)
}

// Puts a push this session just started into its running or finished note, so a session that
// relays before this one polls again counts it
async function refreshNote($) {
  const note = lastNote ?? idleNote
  if (!note || note.pr !== watched?.id) return
  catchUp(note)
  await writeNote($, note)
}

// Leaves this session's note idle: it holds back no other session, and still hands on its push
async function retire($) {
  if (!lastNote) return
  const note = lastNote
  lastNote = null
  // What the session knows belongs to the watch, which may have moved on to another pull request;
  // then the note keeps what it last said
  catchUp(note)
  idleNote = { ...note, running: false, idle: true }
  await writeNote($, idleNote)
}

// Brings a note of the watched pull request up to what this session knows of its pushes
function catchUp(note) {
  if (note.pr !== watched?.id) return
  note.since = Math.max(note.since, knownSince)
  note.pending = pendingPush()
}

function writeNote($, { key, pr, at, since, pending, running, idle }, { strict = false } = {}) {
  const value = { pr, at, since, ...(pending ? { pending } : {}), ...(running ? { running } : {}), ...(idle ? { idle } : {}) }
  const write = $.store.set(key, value)
  return strict ? write : write.catch(() => {})
}

// A push this session ran that has not counted yet, for the session that relays to apply
function pendingPush() {
  return pushedAt ? { at: pushedAt, head: lastHead, ...(pushesRunning > 0 ? { running: true } : {}) } : null
}

// What the other sessions' notes on the same pull request say: defers, whether one of them started
// its poll before this one's (or at the same moment, under a smaller key) in the same round, or is
// still running it, so that every session agrees on the one that relays; since and pending, the
// pushes they know; and pushing, whether one of them is running a push. One that stopped polling or
// failed drops out of the next round by itself, or at once when it left its note idle. A store that
// cannot be read throws, since a note it hides may be the one this poll should yield to.

async function readNotes($, pr, note) {
  const keys = (await $.store.keys()).filter((key) => key.startsWith(POLL_PREFIX) && key !== note.key)
  let defers = false
  let pushing = false
  let since = 0
  const pending = []
  for (const key of keys) {
    const other = await $.store.get(key)
    if (other?.pr !== pr.id || typeof other.at !== 'number') continue
    if (typeof other.since === 'number') since = Math.max(since, other.since)
    if (typeof other.pending?.at === 'number') {
      pending.push(other.pending)
      // One left running by a session that died mid-push holds nothing back for long
      if (other.pending.running && other.pending.at >= note.at - RUNNING_MS) pushing = true
    }
    if (other.idle || other.at > note.at) continue
    if (other.at < note.at - (other.running ? RUNNING_MS : ROUND_MS)) continue
    if (other.at < note.at || key < note.key) defers = true
  }
  return { defers, since, pending, pushing }
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

function takeBack($, key, undo) {
  return exclusive(async () => {
    const record = normalize(await $.store.get(key))
    undo(record)
    await $.store.set(key, record)
  })
}

function exclusive(fn) {
  const run = writes.then(fn, fn)
  writes = run.catch(() => {})
  return run
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

// The pull request, with every connection followed back until it reaches the last push: the
// head commit's date, or since when that is later
async function query($, pr, since) {
  const data = await graphql($, pr, QUERY)
  const floor = Math.max(since, Date.parse(data.commits?.nodes?.[0]?.commit?.committedDate ?? '') || 0)
  for (const kind of Object.keys(CONNECTIONS)) {
    let page = pageOf(data, kind)
    for (let n = 1; page?.pageInfo?.hasPreviousPage && oldest(kind, page) > floor && n < MAX_PAGES; n++) {
      const older = pageOf(await graphql($, pr, queryOf(CONNECTIONS[kind]), page.pageInfo.startCursor), kind)
      if (!older) break
      const items = kind === 'reactors' ? 'edges' : 'nodes'
      older[items] = [...(older[items] ?? []), ...(page[items] ?? [])]
      setPage(data, kind, older)
      page = older
    }
  }
  return data
}

// One page of a connection; the reactors that matter are the thumbs-up's
function pageOf(data, kind) {
  if (kind !== 'reactors') return data[kind]
  return data.reactionGroups?.find((group) => group.content === 'THUMBS_UP')?.reactors
}

function setPage(data, kind, page) {
  if (kind !== 'reactors') data[kind] = page
  else data.reactionGroups.find((group) => group.content === 'THUMBS_UP').reactors = page
}

// When the oldest item on a page happened
function oldest(kind, page) {
  if (kind === 'reactors') return Date.parse(page.edges?.[0]?.reactedAt ?? '') || 0
  // A pending review has no submission time yet, and says nothing about where the page starts
  if (kind === 'reviews') return Date.parse(page.nodes?.find((node) => node.submittedAt)?.submittedAt ?? '') || 0
  return Date.parse(page.nodes?.[0]?.createdAt ?? '') || 0
}

async function graphql($, pr, document, before) {
  const { exitCode, stdout, stderr } = await $.process.run([
    'gh', 'api', 'graphql',
    '-f', `query=${document}`,
    // -f keeps a repository named like a number or a boolean a string; -F types the number
    '-f', `owner=${pr.owner}`,
    '-f', `name=${pr.name}`,
    '-F', `number=${pr.number}`,
    ...(before ? ['-f', `before=${before}`] : []),
  ])
  if (exitCode !== 0) throw new Error(stderr.trim().split('\n')[0] || `gh exited ${exitCode}`)
  const data = JSON.parse(stdout)?.data?.repository?.pullRequest
  if (!data) throw new Error('pull request not found')
  return data
}

// The pull request of the /dev session whose worktree holds this session's cwd: null when no
// session does, false when the one that does has none open. The deepest worktree wins, so one
// nested in another repository's checkout is not taken for it.
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
  if (!session) return null
  if (session.status !== 'pr-open' || !PR_URL.test(session.pr_url ?? '')) return false
  return { url: session.pr_url, since: lastPush(session), sessionFile: best.file }
}

// The open pull request of the branch checked out here: null when there is none, { error } when gh
// could not tell
async function findForBranch($) {
  try {
    const ran = await $.process.run(['gh', 'pr', 'view', '--json', 'url,state'])
    if (ran.exitCode !== 0) {
      if (NO_PR.test(ran.stderr)) return null
      return { error: ran.stderr.trim().split('\n')[0] || `gh exited ${ran.exitCode}` }
    }
    const { url, state } = JSON.parse(ran.stdout)
    return state === 'OPEN' && PR_URL.test(url) ? { url, since: 0 } : null
  } catch (error) {
    return { error: String(error?.message ?? error) }
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
  const now = await $.clock.now()
  const cutoff = now - STALE_MS
  const keys = await $.store.keys()
  await Promise.all(
    keys.map(async (key) => {
      const record = await $.store.get(key)
      let limit
      if (key.startsWith(KEY_PREFIX)) limit = record?.ended ? cutoff : cutoff - (OPEN_STALE_MS - STALE_MS)
      // A poll note matters for one round; one left by a session that did not end cleanly goes later,
      // unless it holds a push the pull request's record has not counted yet
      else if (key.startsWith(POLL_PREFIX)) limit = (await counted($, record)) ? now - HOUR_MS : cutoff
      else return
      if (!(record?.at >= limit)) await $.store.delete(key)
    }),
  )
}

// Whether the pushes a poll note hands on are in its pull request's record already
async function counted($, note) {
  const since = normalize(await $.store.get(KEY_PREFIX + note?.pr)).since
  return !(note?.since > since) && !(note?.pending?.at > since)
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
  // A lookup gh could not answer says so, rather than leaving the line empty or naming an ended one
  if (!watched || (watched.ended && lookupFailure)) {
    if (!lookupFailure) return $.ui.status(undefined)
    return $.ui.status(`PR 検索失敗 ${clock(lookupFailure.at)}: ${lookupFailure.error}`)
  }
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

// Whether a Bash command runs poll-codex-review.sh with --watch, as opposed to merely mentioning it
// in a commit message, a pull request body or a comment. Only a simple command whose command word
// is the script (or a variable this command set to it, as the /dev skill's `"$SCRIPT" ... --watch`
// does) counts. Quoted strings stay one word and here-document bodies and comments are dropped, so
// prose never reads as a command. Anything less plain (`bash -c '...'`, `$(...)`) is let through:
// a missed deny only lets the skill wait the old way, while a wrong one blocks unrelated work.
const SCRIPT = /(^|\/)poll-codex-review\.sh$/
// Words that may stand before the command word without being it
// (matched by basename, so `/bin/bash` counts too)
const PREFIXES = new Set(['!', '{', 'do', 'then', 'else', 'if', 'elif', 'while', 'until', 'time',
  'export', 'exec', 'command', 'nohup', 'env', 'timeout', 'bash', 'sh', 'zsh', 'source', '.'])
const SHELLS = new Set(['bash', 'sh', 'zsh'])
// Options of those prefixes that take the next word as their value (`timeout -s TERM 600`)
const OPTION_VALUES = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
}
// A shell word: quoted parts, escapes and plain characters, up to an unquoted blank or operator
const SHELL_WORD = /^(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s;&|<>()'"\\])+/

function runsWatch(command) {
  if (!command.includes('poll-codex-review')) return false
  // Variables set to the script, one set per subshell: an assignment inside `( )` ends with it
  const scopes = [new Set()]
  for (const entry of simpleCommands(command)) {
    if (entry === OPEN) {
      scopes.push(new Set(scopes.at(-1)))
      continue
    }
    if (entry === CLOSE) {
      if (scopes.length > 1) scopes.pop()
      continue
    }
    const words = entry
    const scripts = scopes.at(-1)
    let i = 0
    let prefix = null
    let notRun = false
    // Assignments last past this command only when no command word follows them
    const assignments = []
    for (; i < words.length; i++) {
      const { text } = words[i]
      const assigned = /^([A-Za-z_]\w*)=(.*)$/s.exec(text)
      if (assigned) {
        assignments.push(assigned)
        continue
      }
      const name = text.slice(text.lastIndexOf('/') + 1)
      if (PREFIXES.has(name)) {
        prefix = name
        continue
      }
      // `bash -n` reads the script without running it, and `command -v` only looks it up
      if (SHELLS.has(prefix) && /^-[A-Za-z]*n/.test(text)) notRun = true
      if (prefix === 'command' && /^-[A-Za-z]*[vV]/.test(text)) notRun = true
      if (OPTION_VALUES[prefix]?.includes(text)) i += 1
      if (text.startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(text)) continue
      break
    }
    if (i >= words.length) {
      for (const [, name, value] of assignments) {
        if (SCRIPT.test(value)) scripts.add(name)
        else scripts.delete(name)
      }
      continue
    }
    if (notRun) continue
    // A `$` that was quoted or escaped is a literal, not a variable
    const variable = !words[i].literal && /^\$\{?([A-Za-z_]\w*)\}?$/.exec(words[i].text)
    const isScript = variable ? scripts.has(variable[1]) : SCRIPT.test(words[i].text)
    if (isScript && words.slice(i + 1).some((w) => w.text === '--watch')) return true
  }
  return false
}

const OPEN = Symbol('(')
const CLOSE = Symbol(')')

// Splits a command into simple commands (on newlines, `;`, `&`, `|`, `(` and `)` outside quotes),
// each a list of words with their quotes removed, with OPEN and CLOSE where a `(` or `)` stood.
// Here-document bodies and comments are skipped.
function simpleCommands(command) {
  const commands = []
  let words = []
  let word = null
  let quoted = false
  // Whether the word holds a `$` that cannot expand
  let literal = false
  const heredocs = []
  // The next word is a redirection's target, not part of the command
  let target = false
  const endWord = () => {
    if (word !== null && !target) words.push({ text: word, literal })
    if (word !== null) target = false
    word = null
    quoted = false
    literal = false
  }
  // Drops a file descriptor number written right before a redirection (`2>`)
  const redirect = () => {
    if (word !== null && /^\d+$/.test(word) && !quoted) word = null
    endWord()
    target = true
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
    target = false
  }
  let i = 0
  while (i < command.length) {
    const c = command[i]
    if (c === '\n') {
      endCommand()
      i += 1
      // Skips each pending here-document's body, up to and including its delimiter line
      for (const { delimiter, stripTabs } of heredocs.splice(0)) {
        while (i < command.length) {
          const eol = command.indexOf('\n', i)
          const line = command.slice(i, eol < 0 ? command.length : eol)
          i = eol < 0 ? command.length : eol + 1
          if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break
        }
      }
    } else if (c === '\\') {
      if (command[i + 1] !== '\n') word = (word ?? '') + (command[i + 1] ?? '')
      if (command[i + 1] === '$') literal = true
      i += 2
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end < 0 ? command.length : end
      word = (word ?? '') + command.slice(i + 1, stop)
      quoted = true
      if (command.slice(i + 1, stop).includes('$')) literal = true
      i = stop + 1
    } else if (c === '"') {
      let text = ''
      i += 1
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && command[i + 1] === '\n') {
          i += 2
          continue
        }
        if (command[i] === '\\' && '"\\$`'.includes(command[i + 1] ?? '')) {
          i += 1
          if (command[i] === '$') literal = true
        }
        text += command[i] ?? ''
        i += 1
      }
      word = (word ?? '') + text
      quoted = true
      i += 1
    } else if (c === '#' && word === null) {
      const eol = command.indexOf('\n', i)
      i = eol < 0 ? command.length : eol
    } else if (command.startsWith('<<<', i)) {
      redirect()
      i += 3
    } else if (command.startsWith('<<', i)) {
      endWord()
      const m = /^<<(-?)[ \t]*/.exec(command.slice(i))
      const delimiter = SHELL_WORD.exec(command.slice(i + m[0].length))
      if (!delimiter) {
        i += 2
        continue
      }
      // Quote removal, as Bash does to the delimiter word
      const unquoted = delimiter[0].replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g,
        (_, single, double, escaped) => single ?? escaped ?? double.replace(/\\([$`"\\\n])/g, '$1'))
      heredocs.push({ delimiter: unquoted, stripTabs: m[1] === '-' })
      i += m[0].length + delimiter[0].length
    } else if (c === '&' && command[i + 1] === '>') {
      redirect()
      i += command[i + 2] === '>' ? 3 : 2
    } else if (';&|()'.includes(c)) {
      endCommand()
      if (c === '(') commands.push(OPEN)
      if (c === ')') commands.push(CLOSE)
      i += 1
    } else if (c === '<' || c === '>') {
      redirect()
      // `>>`, `<>` and the `&` of `2>&1` belong to the redirection, not a background `&`
      i += 1
      if (command[i] === '>' || (c === '<' && command[i] === '>')) i += 1
      if (command[i] === '&') i += 1
    } else if (c === ' ' || c === '\t') {
      endWord()
      i += 1
    } else {
      word = (word ?? '') + c
      i += 1
    }
  }
  endCommand()
  return commands
}

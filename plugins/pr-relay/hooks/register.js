// Watches this session's pull request on a timer and wakes the session only when something
// changed: a merge, a Codex review, or Codex's thumbs-up. The model then never has to poll.

// How often to ask GitHub about the pull request. One GraphQL query a tick costs one point of the
// 5,000 an hour, so even a dozen sessions polling at once stay far below the limit.
const TICK_MS = 60_000
// The desktop app exposes its cached pull requests through this tool
const DESKTOP_STATUS = 'mcp__ccd_pr__get_status'
// Codex's login as GraphQL spells it (REST adds "[bot]")
const CODEX = 'chatgpt-codex-connector'
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
const LATE = 'poll outlasted its turn'
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
  reviews: `reviews(${PAGE}) { ${PAGE_INFO} nodes { id databaseId submittedAt author { login } comments { totalCount } } }`,
  comments: `comments(${PAGE}) { ${PAGE_INFO} nodes { createdAt author { login } body } }`,
}
const MAX_PAGES = 10
const queryOf = (fields) => `query($owner: String!, $name: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${fields} } }
}`
const QUERY = queryOf(`state headRefOid headRefName commits(last: 1) { nodes { commit { committedDate } } } ${Object.values(CONNECTIONS).join(' ')}`)
// Review bodies stay out of the per-minute query so gh's output does not get cut
const REVIEW_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequestReview {
    databaseId url submittedAt commit { oid } body
    comments(first: 100) { totalCount nodes { databaseId path line originalLine url body outdated } }
  } }
}`
// The most characters of a body to include before linking to the full text
const BODY_LIMIT = 4_000
// The most characters in a review prompt, including the omitted count and approval note
const PROMPT_LIMIT = 30_000

// The pull request this session watches: { url, id, owner, name, number, since, pagedAt?, ended? },
// or null. since is the last push the watch started from.
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
// The head of the watched pull request as this session's last poll found it, and when
let lastHead = null
let lastHeadAt = 0
// This session's latest poll note, { key, pr, at, since, pending, running, serial }, as last written,
// so an older poll does not mark it finished, a push can update it and a stop can leave it idle
let lastNote = null
// The notes a stop left idle, by key, which a push that finishes later still updates
const retired = new Map()
// The last write of each note key still going out
const noteWrites = new Map()
// Tells apart the polls of one session, which may share a key and a time
let noteSerial = 0
// Cleanup offers stay newest first, with at most three rows shown
let cleanupOffers = []
// Offers waiting for their prompts stay in order but are hidden until submission settles
const cleanupPending = new Set()
// Desktop availability is asked once per conversation and kept separately from watch timers
let desktopAvailable = null
// The desktop timer survives a watch change or the watched pull request ending
let desktopTimer = null
// This generation is reading the desktop cache, so slow calls do not pile up within a watch
let desktopPolling = null
// Successful desktop reads keep the last primary URL here
let lastPrimary = null
// This map keeps the last known bound states in this conversation by parsed URL id
let boundStates = new Map()
// The git push calls this session ran for the watched pull request that have not counted yet, each
// { id, pr, at, head, shas, refs, running }: its own id, the pull request it was bound to (null when
// none was watched), when it started, the head the pull request had as far as the session knew
// then, and once it has finished, the commits it moved refs to and the commit each branch moved to
// (null when its output does not say). A push becomes the baseline only once GitHub shows what it pushed, since one that changed
// nothing ("Everything up-to-date", another branch) must not hide the events that came before it.
// Notes hold the same objects, so a push that finishes after the session turned to another pull
// request still updates the note it was in.
let pushes = []
// How many pushes this session started for each pull request
const pushStarts = new Map()
// The session id as last asked, so a push need not wait on it
let sessionId = null
let idAsks = 0
// git push calls still running. While one is, what Codex said may be about the head it replaces,
// so nothing is relayed until it ends.
// The read, change and write of a record in this session, one after another: a poll and a send
// that takes its mark back would otherwise each write what they read before the other wrote
let writes = Promise.resolve()

export function register(on) {
  // Fires again on an enable or a worker respawn, which may keep this module's variables
  on('session.start', async ($, e, next) => {
    sessionIdOf($).catch(() => {})
    stop({ desktop: true })
    await retire($)
    reset($)
    await $.tool.register({
      name: 'watch',
      description:
        'pr-relay polls a pull request for this session and sends a prompt when it is merged, when Codex ' +
        'reviews it, or when Codex gives it a thumbs-up. While it watches, do not poll for those yourself ' +
        '(sleep loops, polling scripts, ScheduleWakeup): end the turn and wait to be woken. ' +
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
    startDesktop($)
    // Finding the pull request calls tools, so it starts once the session is ready
    timers.push($.clock.after(0, () => discover($)))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (FINAL_REASONS.includes(e.reason)) {
      stop({ desktop: true })
      await retire($)
    }
    return next(e)
  })

  // /resume can turn this process to another conversation without a new session.start, and that
  // conversation may belong to another worktree and pull request. /clear and /branch (fork) go on
  // in the same one, but under a new id as well: the note under the last id is left idle, since
  // that conversation no longer runs here, and the pull request is looked up again
  on('classic.SessionStart', { source: ['resume', 'clear', 'fork'] }, async ($, e, next) => {
    // The new conversation has its own id, so a push before its first poll must not write under
    // the last one's
    sessionId = null
    sessionIdOf($).catch(() => {})
    stop({ desktop: true })
    await retire($)
    reset($)
    startDesktop($)
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
    // Best effort: a push made another way is caught by the head commit's date, and session.start
    // looks up the branch's pull request
    const creates = /\bgh\s+pr\s+create\b/.test(command)
    const pushing = !creates && /\bgit\s+push\b/.test(command)
    if (!creates && !pushing) return next(e)
    // Bound to the pull request watched as the push starts, before anything else can turn the
    // watch to another
    const prId = watched && !watched.ended ? watched.id : null
    // A failure to publish is shown only while the watch the push started under lasts
    const watchGen = generation
    // Codex reviews what was pushed, so its earlier activity says nothing about this push. The push
    // is counted as started before anything is awaited, so a poll finishing meanwhile holds back
    // what it read from the head being replaced; a watch that turns to another pull request while
    // the time is read leaves it behind with the rest of the last one's pushes
    let push = null
    if (pushing) {
      push = { id: null, pr: prId, at: null, head: null, shas: null, running: true }
      if (prId) pushStarts.set(prId, (pushStarts.get(prId) ?? 0) + 1)
      pushes.push(push)
    }
    // The time is set before the push runs, so a poll that sees the new head while it is still
    // finishing already applies it, and put back if the push failed
    const startedAt = await $.clock.now()
    if (pushing) {
      push.at = startedAt
      // id tells parallel pushes started in the same millisecond apart, in this session and others
      push.id = pushId(startedAt)
      for (const note of notesOf(prId)) {
        note.pending = [...note.pending.filter((p) => p !== push), push]
        note.dirty = true
      }
      // A pull request with no note yet (its first poll has not written one, or the watch turned
      // away first) gets an idle one, so the other sessions see the push run; the first poll takes
      // it up
      if (prId && !notesOf(prId).length) {
        // The id is known from the start, so the push goes out without waiting on it
        const key = `${POLL_PREFIX}${sessionId ?? (await sessionIdOf($))}:${prId}`
        if (!notesOf(prId).length) retired.set(key, { key, pr: prId, at: startedAt, since: 0, pending: [push], idle: true, dirty: true })
      }
      // The other sessions hold back their relays only if they can see the push, so it goes out
      // running before its head is looked up, and again with the head; a store that will not take
      // it is shown rather than holding up the push
      const publish = () =>
        refreshNote($, { strict: true }).catch((error) => {
          if (generation !== watchGen || (watched?.id ?? null) !== prId) return
          lastCheck = { at: startedAt, error: `push note: ${error?.message ?? error}` }
          showStatus($)
        })
      await publish()
      push.head = await headBefore($, prId)
      for (const note of notesOf(prId)) note.dirty = true
      await publish()
      // Codex activity that came while the notes went out is still about the head being replaced,
      // so the push counts from when it actually runs; the notes take the time with its end
      push.at = await $.clock.now()
      for (const note of [lastNote, ...retired.values()]) if (note?.pending.includes(push)) note.dirty = true
      // The other sessions hold back for RUNNING_MS from the time they see, so they see this one
      await publish()
      // Activity that came while that went out is still about the head being replaced, so the push
      // counts from here; the notes take this time with the push's end, which is when it applies
      push.at = await $.clock.now()
      for (const note of [lastNote, ...retired.values()]) if (note?.pending.includes(push)) note.dirty = true
      // and the other sessions hold back from it too, so it goes out as Bash runs, not before
      publish()
    }
    // The other sessions hold back their relays only while the push runs
    const finish = async ({ dropped = false, shas = null, refs = null } = {}) => {
      // A poll whose GitHub answer came before this may have seen the head the push replaced
      push.doneAt = await $.clock.now()
      push.running = false
      if (dropped) push.dropped = true
      else {
        push.shas = shas
        push.refs = refs
      }
      pushes = pushes.filter((p) => !p.dropped)
      for (const note of [lastNote, ...retired.values()]) if (note?.pending.includes(push)) note.dirty = true
      await refreshNote($)
    }
    let ran
    try {
      ran = await next(e)
    } catch (error) {
      // Whether it pushed is unknown, so it counts only once the head moves
      if (push) await finish().catch(() => {})
      throw error
    }
    // A push that failed or moved nothing says nothing about what Codex reviewed
    const failed = ran.deny !== undefined || ran.isError
    const moved = push && !failed ? pushedCommits(ran) : null
    if (push) await finish({ dropped: failed || moved?.shas.length === 0, shas: moved?.shas, refs: moved?.refs })
    if (failed) return ran
    if (creates) {
      const url = ran.text?.match(PR_URL)?.[0]
      if (url) watch($, { url, since: startedAt })
    } else {
      if (!watched || watched.ended) timers.push($.clock.after(0, () => discover($, { branchOnly: true })))
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cleanupOffers.length) return next(e)
    const elements = $.ui.resolve(e)
    const lines = cleanupOffers.filter((offer) => !cleanupPending.has(offer)).slice(0, 3).map((offer) => {
      const { url, number } = offer
      const { id } = parse(url)
      const close = () => {
        cleanupOffers = cleanupOffers.filter((entry) => entry !== offer)
        $.ui.invalidate('ui.render')
      }
      return elements.Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          elements.Text({ children: [`PR #${number} がマージされました`] }),
          elements.Button({
            key: `cleanup-${id}`,
            label: 'cleanup',
            variant: 'primary',
            onPress: async () => {
              cleanupPending.add(offer)
              $.ui.invalidate('ui.render')
              const text = `PR ${url} がマージされました。この worktree とローカルブランチを片付けてください。消す前に、未コミットの変更や push していないコミットが残っていないかを確かめ、残っていれば消さずに報告してください。`
              // A prompt that did not enter reveals its row in place, unless a new watch or a
              // conversation reset removed that offer while it waited
              if (await submit($, text)) close()
              cleanupPending.delete(offer)
              $.ui.invalidate('ui.render')
            },
          }),
          elements.Button({ key: `dismiss-${id}`, label: '閉じる', role: 'dismiss', onPress: close }),
        ],
      })
    })
    // Keep what the mods after this one draw in the band
    const rest = await next(e)
    return elements.Box({ flexDirection: 'column', children: [...lines, ...(rest ? [rest] : [])] })
  })
}

function reset($) {
  watched = null
  lastCheck = null
  lookupFailure = null
  cleanupOffers = []
  cleanupPending.clear()
  desktopAvailable = null
  desktopPolling = null
  lastPrimary = null
  boundStates = new Map()
  pushes = []
  $.ui.invalidate('ui.render')
  showStatus($)
}

// Looks for the pull request to watch, and asks again a tick later when gh could not answer
async function discover($, { branchOnly = false } = {}) {
  if (watched && !watched.ended) return
  const gen = generation
  // Pruning is startup housekeeping, skipped for a lookup after a push; a store that fails it
  // does not keep the pull request unwatched
  if (!branchOnly) await prune($).catch(() => {})
  if (gen !== generation) return
  const desktop = branchOnly ? null : await readDesktop($)
  if (gen !== generation) return
  const found = desktop?.primary?.state === 'OPEN'
    ? { url: desktop.primary.url, since: 0 }
    : await findForBranch($)
  const at = await $.clock.now()
  if ((watched && !watched.ended) || gen !== generation) return
  if (desktop) {
    lastPrimary = desktop.primary?.url ?? null
    trackBound($, desktop)
  }
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
function watch($, { url, since }) {
  stop()
  const gen = generation
  const pr = parse(url)
  // The note of the poll this stops must not hold back the sessions still watching its pull request
  // while this watch's first poll starts; watching the same pull request again, its first poll
  // takes up what the note held
  if (lastNote) retire($)
  // A push still waiting for its head to move stays with the pull request it was bound to, even one
  // that ended; one made while none was watched is the push that led here
  if (watched?.id !== pr.id) pushes = pushes.filter((push) => !push.pr)
  // The pull request that takes up a push made while none was watched keeps it
  for (const push of pushes) push.pr ??= pr.id
  // Watching the same pull request again keeps the baseline its polls learned
  if (watched?.id !== pr.id) knownSince = 0
  watched = { ...pr, since }
  lookupFailure = null
  lastHead = null
  lastHeadAt = 0
  // Watching a pull request again removes only its own cleanup offer
  removeCleanup($, pr.id)
  // Ask at once: a review or a merge may have come while no session watched
  timers.push($.clock.after(0, () => poll($, gen)))
  timers.push($.clock.every(TICK_MS, () => poll($, gen)))
}

function stop({ desktop = false } = {}) {
  for (const timer of timers) timer?.cancel()
  timers = []
  if (desktop) {
    desktopTimer?.cancel()
    desktopTimer = null
  }
  generation += 1
}

// Each conversation starts its own desktop timer and asks once whether the tool is available
function startDesktop($) {
  desktopAvailable = $.tool.list().then(
    (tools) => tools.some((tool) => tool.name === DESKTOP_STATUS),
  ).catch(() => false)
  desktopTimer = $.clock.every(TICK_MS, () => refreshDesktop($))
}

// This source reads only the app's cache and leaves gh discovery available after any tool failure
async function readDesktop($) {
  try {
    if (!(await desktopAvailable)) return null
    const ran = await $.tool.call({ tool: DESKTOP_STATUS })
    if (ran.deny !== undefined || ran.isError) return null
    const status = JSON.parse(ran.text)
    if (!status || typeof status !== 'object' || Array.isArray(status)) return null
    if (status.bound === false) return { primary: null, others: [] }
    const pull = (url, state) => {
      if (typeof url !== 'string' || url.match(PR_URL)?.index !== 0) return null
      const pr = parse(url)
      if (!Number.isSafeInteger(pr.number) || pr.number <= 0) return null
      return { url: pr.url, number: pr.number, state: typeof state === 'string' ? state.toUpperCase() : null }
    }
    const pr = status.pr
    const primary = pr?.host == null || pr.host.toLowerCase?.() === 'github.com' ? pull(pr?.url, pr?.state) : null
    const others = (Array.isArray(status.otherBoundPrs) ? status.otherBoundPrs : []).flatMap((other) => {
      if (typeof other?.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(other.repo)) return []
      if (!Number.isSafeInteger(other.number) || other.number <= 0) return []
      const parsed = pull(`https://github.com/${other.repo}/pull/${other.number}`, other.state)
      return parsed ? [parsed] : []
    })
    return { primary: primary ? { url: primary.url, state: primary.state } : null, others }
  } catch {
    return null
  }
}

// Only a changed open primary takes over a watch explicitly set by the model
async function refreshDesktop($) {
  const gen = generation
  if (desktopPolling === gen) return
  desktopPolling = gen
  try {
    const desktop = await readDesktop($)
    if (!desktop || gen !== generation) return
    const primary = desktop.primary
    const id = primary ? parse(primary.url).id : null
    if (primary?.state === 'OPEN' && id !== (lastPrimary ? parse(lastPrimary).id : null) && id !== watched?.id) {
      watch($, { url: primary.url, since: 0 })
    }
    lastPrimary = primary?.url ?? null
    trackBound($, desktop)
  } finally {
    if (desktopPolling === gen) desktopPolling = null
  }
}

// Bound states include the watched pull request, whose notifications still come from its poll
function trackBound($, { primary, others }) {
  for (const entry of [...others, ...(primary ? [primary] : [])]) {
    const pr = parse(entry.url)
    const { state } = entry
    if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') continue
    const previous = boundStates.get(pr.id)
    boundStates.set(pr.id, state)
    if (pr.id === watched?.id || previous !== 'OPEN' || !ENDED[state]) continue
    $.ui.toast(`PR #${pr.number} が${ENDED[state]}されました`)
    if (state === 'MERGED') offerCleanup($, pr)
  }
}

// A merged pull request goes at the front without duplicating an existing offer
function offerCleanup($, { url, number }) {
  const { id } = parse(url)
  if (cleanupOffers.some((offer) => parse(offer.url).id === id)) return
  cleanupOffers.unshift({ url, number })
  $.ui.invalidate('ui.render')
}

// Watching a pull request again removes only its own offer, including one awaiting a prompt
function removeCleanup($, id) {
  const remaining = cleanupOffers.filter((offer) => parse(offer.url).id !== id)
  if (remaining.length === cleanupOffers.length) return
  cleanupOffers = remaining
  $.ui.invalidate('ui.render')
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
  await settleRetired($)
  const pr = watched
  const key = KEY_PREFIX + pr.id
  // A watch that began while the retired notes settled owns what the session knows now
  if (gen !== generation) return
  // What an earlier poll of this watch paged through is not asked for again
  const floor = Math.max(pr.since, (pr.pagedAt ?? 0) - PAGE_OVERLAP_MS)
  // Noted before asking, so a session that starts polling while this one waits on GitHub finds it,
  // with the pushes known already, so a session that relays before this one finishes counts them
  knownSince = Math.max(knownSince, pr.since)
  // A poll the other sessions cannot see would relay beside the one they elect, so it waits a tick
  const note = await notePoll($, pr, gen).catch(async (error) => {
    lastCheck = { at: await $.clock.now(), error: `poll note: ${error?.message ?? error}` }
    showStatus($)
    return null
  })
  if (!note) return
  const now = note.at
  try {
    await pollNoted($, gen, { pr, key, now, floor, note })
  } finally {
    await finishNote($, note)
  }
}

async function pollNoted($, gen, { pr, key, now, floor, note }) {
  // Read before GitHub is asked: a push that starts, and even finishes, while the query or the
  // record is on its way may have replaced the head the query saw
  const started = pushStarts.get(pr.id) ?? 0
  const answer = await query($, pr, floor).catch((error) => ({ error }))
  // When GitHub showed the head, which is what tells a fresher head from a staler one
  const seenAt = answer.seenAt
  const answeredAt = await $.clock.now()
  // A watch that began meanwhile owns the state now
  if (gen !== generation) return
  // A query that outlasted the time the others wait on a running note may have seen another
  // session take the round over, which this one's election cannot tell: it relays nothing
  if (!answer.error && lapsed(now, answeredAt)) answer.error = new Error(LATE)
  if (answer.error) {
    // A poll that learned nothing relays nothing, so it must not hold back the others' this round,
    // but the push it knows of still counts
    await retire($)
    // A watch that began while the note was left idle shows its own state
    if (gen !== generation) return
    lastCheck = { at: now, error: String(answer.error?.message ?? answer.error) }
    showStatus($)
    return
  }
  const { data } = answer
  // Another session polling this pull request in the same round, ahead of this one, relays what is
  // new; this one leaves the record to it and passes on what it knows through its note
  // Notes it could not read may hold an earlier poll, so this one then learned nothing either
  const notes = await readNotes($, pr, note).catch((error) => ({ error }))
  // Read before the watch is checked, so nothing waits between the check and what follows
  const readAt = await $.clock.now()
  if (gen !== generation) return
  if (notes.error) {
    await retire($)
    if (gen !== generation) return
    lastCheck = { at: now, error: `poll notes: ${notes.error?.message ?? notes.error}` }
    showStatus($)
    return
  }
  // So may one whose store answered too late
  if (lapsed(now, readAt)) return late($, now, pr, note)
  const { defers, since: othersSince, pending, pushing } = notes
  // Said in the note, so a later poll of another session does not yield to this one in turn
  if (defers && lastNote?.serial === note.serial) {
    lastNote.deferred = true
    // Written before the record is read, which the store may keep waiting. One the store refused
    // would leave the others yielding to a poll that relays nothing, so the poll stops as failed
    const refused = await writeNote($, lastNote, { strict: true }).then(
      () => null,
      (error) => error,
    )
    // A watch that began while it went out owns the head and the baseline now
    if (gen !== generation) return
    if (refused) {
      await retire($)
      if (gen !== generation) return
      lastCheck = { at: now, error: `poll note: ${refused?.message ?? refused}` }
      showStatus($)
      return
    }
  }
  if (data.headRefOid) {
    lastHead = data.headRefOid
    lastHeadAt = seenAt
  }
  lastCheck = { at: now }
  // One that leaves the waking to another session leaves the end to it too, and sees it next round
  // from the record, as the session that relays: only then does it stop and offer the cleanup
  const ended = !defers && (data.state === 'MERGED' || data.state === 'CLOSED')
  let endedGen = null
  if (ended) {
    stop()
    endedGen = generation
    watched = { ...watched, ended: data.state }
    if (data.state === 'MERGED') {
      offerCleanup($, pr)
    }
  }

  // The watch ends only once the end is told: one a push took back, or that never reached the
  // record, polls on so a later round tells it
  let told = !ended
  try {
    let noted = 0
    const sends = await exclusive(async () => {
      const record = normalize(await $.store.get(key))
      const writeAt = await $.clock.now()
      // A watch that began while this waited its turn owns the pushes and the marks now
      if (gen !== generation && !ended) return null
      // Checked once more just before the record is written, since the store may have kept it waiting
      if (lapsed(now, writeAt)) return LATE
      // An ended poll goes on past a new watch, whose baseline is not this pull request's: it goes by
      // what its note said
      const owns = watched?.id === pr.id
      noted = Math.max(othersSince, owns ? knownSince : note.since)
      const sends = update($, pr, data, record, noted, pending, defers, pushing, now, seenAt)
      // The session that relays writes the record at about this moment, so a copy read before its
      // marks must not land over them: one that leaves it the waking writes only its own note
      if (owns) knownSince = Math.max(knownSince, record.since)
      if (defers) return sends
      record.at = now
      if (data.headRefOid) record.headAt = seenAt
      await $.store.set(key, record)
      // A write that landed past the lease may have gone over a session that took the round over and
      // relayed the same, so this one sends nothing; $.store has no conditional write to stop it.
      // Its marks are taken back, since a session that has not taken the round over yet would read
      // them as sent, and nothing would send them
      if (lapsed(now, await $.clock.now())) return { late: sends }
      // Pages are skipped next time only once what they held is in the record: a session that leaves
      // the waking to another goes through them again in case that one never writes it
      if (gen === generation) watched = { ...watched, pagedAt: now }
      return sends
    })
    if (sends === null) return
    if (sends === LATE) return late($, now, pr, note)
    if (sends.late) {
      takeBackAll($, key, sends.late, pr)
      return late($, now, pr, note)
    }
    // Only once the record says they were relayed, so a send that fails can take its mark back. A
    // watch that began during the write (an ended pull request stopped the timers itself) takes
    // the marks back instead, and a later watch of this pull request sends them.
    // A push this session started meanwhile, running or already done, may have replaced the head
    // they were read from
    let pushedSince = (pushStarts.get(pr.id) ?? 0) !== started
    // So may one another session started after its notes were read, which only they say
    if (sends.length && !pushedSince) {
      // A push known already that has finished since, even one that had run past the time it holds
      // the relays back, counts the same as a new one
      const state = (push) => `${push.running ? 'running' : 'done'}:${push.doneAt ?? ''}`
      const known = new Map(pending.map((push) => [pushKey(push), state(push)]))
      const moved = (again) =>
        !again ||
        again.pushing ||
        again.since > noted ||
        again.pending.some((push) => known.get(pushKey(push)) !== state(push))
      pushedSince = moved(await readNotes($, pr, note).catch(() => null))
      // A read the store kept waiting past the lease may have let another session take the round
      // over; it read the marks, which this one wrote in time, so it sent nothing: they are taken back
      // for the next round to send
      if (lapsed(now, await $.clock.now())) {
        takeBackAll($, key, sends, pr)
        return late($, now, pr, note)
      }
      // A push this session started while the clock was read counts too, and so does one another
      // session started meanwhile, which a last read of the notes shows; the lease keeps ROUND_MS
      // for it, and nothing waits between it and the sends
      pushedSince ||= (pushStarts.get(pr.id) ?? 0) !== started
      if (!pushedSince) pushedSince = moved(await readNotes($, pr, note).catch(() => null))
      pushedSince ||= (pushStarts.get(pr.id) ?? 0) !== started
    }
    const current = (gen === generation || ended) && !pushedSince && !(watched?.id === pr.id && pushes.some((push) => holds(push, now)))
    if (current) {
      told = true
      for (const send of sends) deliver($, key, send)
    } else takeBackAll($, key, sends, pr)
    showStatus($)
  } finally {
    if (!told) reopen($, pr, endedGen)
  }
}

// Watches a pull request again whose end a poll could not tell, unless a new watch began since
function reopen($, pr, gen) {
  if (gen !== generation || watched?.id !== pr.id || !watched.ended) return
  watched = { ...watched, ended: null }
  removeCleanup($, pr.id)
  timers.push($.clock.every(TICK_MS, () => poll($, gen)))
  showStatus($)
}

// Whether a poll started at now has run so long that another session may have taken its round over
function lapsed(now, at) {
  return at >= now + RUNNING_MS - ROUND_MS
}

// A poll that lapsed relays nothing, and says so. An ended one that a new watch went past leaves
// that watch's note and status alone.
async function late($, now, pr, note) {
  if (lastNote?.serial === note.serial) await retire($)
  if (watched?.id !== pr.id) return
  lastCheck = { at: now, error: LATE }
  showStatus($)
}

// Brings the record up to the pull request's state, and returns the prompts to send for what is new
function update($, pr, data, record, notedPush, pending, defers, pushing, now, seenAt) {
  // Codex reviews pushes, so only its activity after the latest push counts. The thumbs-up in
  // particular is one reaction per pull request whose time can stay at an earlier push: its mere
  // presence would read as an approval of every later push.
  const committedAt = Date.parse(data.commits?.nodes?.[0]?.commit?.committedDate ?? '') || 0
  record.since = Math.max(record.since, pr.since, committedAt, notedPush)
  // An ended poll that finishes after the watch turned leaves the next pull request's pushes alone
  if (watched?.id === pr.id) {
    pushes = pushes.filter((push) => {
      // The record's head is the head before the push only if GitHub showed it before the push
      // started; one seen later may already be what the push put there
      const recordHead = (record.headAt ?? 0) < push.at ? record.head : null
      if (!pushCounts(push, data, now, { recordHead })) return true
      record.since = Math.max(record.since, push.at)
      return false
    })
  }
  // Another session's push counts by the same rule; one that knew no head before it cannot tell a
  // push that moved nothing from one that did, so it waits for that session's own poll
  for (const push of pending) {
    if (pushCounts(push, data, now)) record.since = Math.max(record.since, push.at)
  }
  record.head = data.headRefOid ?? record.head
  if (data.state === 'MERGED' || data.state === 'CLOSED') {
    if (!record.ended && !defers) {
      const state = data.state
      record.ended = state
      // Raised once the record says so in time, like a prompt
      return [
        {
          toast: `PR #${pr.number} が${ENDED[state]}されました`,
          undo: (r) => {
            if (r.ended === state) r.ended = null
          },
        },
      ]
    }
    return []
  }
  // A reopened pull request ends again, and that end is news again
  record.ended = null
  // A push running in any session may be replacing the head GitHub still shows; this session's
  // own are those it bound to this pull request
  const running = pushes.some((push) => holds(push, now))
  // So may one that finished after GitHub answered, which the head GitHub showed cannot tell from a
  // push that moved nothing; the next poll sees what it left. One that finished in the same
  // millisecond may have too, and one handed on with no end time counts from its start
  const unseen = (push) => !push.running && (typeof push.doneAt === 'number' ? push.doneAt >= seenAt : push.at >= seenAt)
  const replaced =
    (watched?.id === pr.id && pushes.some(unseen)) || pending.some((push) => unseen(push) && !pushCounts(push, data, now))
  return running || pushing || defers || replaced ? [] : relay($, pr, read(data, record.since), record)
}

// The cache takes only the latest answer, so one asked before a /resume cannot land over it
async function sessionIdOf($) {
  const ask = ++idAsks
  const id = await $.session.id()
  if (ask === idAsks) sessionId = id
  return id
}

// Notes that this session starts a poll of the pull request now, and returns the note
async function notePoll($, pr, gen) {
  // One note per pull request, so a session that turns to another leaves this one's push behind
  const key = `${POLL_PREFIX}${await sessionIdOf($)}:${pr.id}`
  // A worker respawn starts this module afresh while the session's note from before stays in the
  // store, still holding what the record may not have counted; a read that fails is retried
  const stored = lastNote?.key === key || retired.has(key) ? null : await $.store.get(key)
  // Read just before the note goes out, since the time is this poll's place in the election
  const at = await $.clock.now()
  if (gen !== generation) return null
  // The note under the id before /clear or /resume would read as another session's poll
  if (lastNote && lastNote.key !== key) await retire($)
  // Watching the same pull request again starts from what its note last said
  if (lastNote?.key === key) knownSince = Math.max(knownSince, lastNote.since)
  // Coming back to a pull request this session left, its note still holds pushes the record may
  // not have counted yet
  const left = retired.get(key)
  if (left) {
    knownSince = Math.max(knownSince, left.since)
    for (const push of left.pending) if (!push.dropped && !pushes.includes(push)) pushes.push(push)
    retired.delete(key)
  } else if (stored?.pr === pr.id) {
    if (typeof stored.since === 'number') knownSince = Math.max(knownSince, stored.since)
    for (const push of [].concat(stored.pending ?? [])) {
      if (typeof push?.at !== 'number' || pushes.some((p) => pushKey(p) === pushKey(push))) continue
      // Whether a push the last module saw running pushed anything is unknown, so it counts once
      // the head moves; one that may still run (the worker went, not the Bash call) holds the
      // relays back as long as another session's would
      const finished = !push.running
      const live = !finished && push.at >= at - RUNNING_MS
      pushes.push({
        id: push.id ?? null,
        pr: pr.id,
        at: push.at,
        head: push.head ?? null,
        shas: finished ? (push.shas ?? null) : null,
        refs: finished ? (push.refs ?? null) : null,
        ...(finished && typeof push.doneAt === 'number' ? { doneAt: push.doneAt } : {}),
        running: live,
      })
    }
  }
  lastNote = { key, pr: pr.id, at, since: knownSince, pending: [...pushes], running: true, serial: ++noteSerial }
  await writeNote($, lastNote, { strict: true })
  // A note other sessions wrote while this one's was on its way may have been elected without
  // seeing it, so the poll yields to those too
  return { ...lastNote, landedAt: await $.clock.now() }
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
async function refreshNote($, { strict = false } = {}) {
  const writes = []
  for (const note of [lastNote, ...retired.values()]) {
    if (!note || (note.pr !== watched?.id && !note.dirty)) continue
    catchUp(note)
    writes.push(writeNote($, note, { strict }))
  }
  await Promise.all(writes)
}

// Rewrites the notes this session left until the store has taken each as idle and with its pushes
// as they stand; a write the store refused is tried again on the next poll. Each is kept for as
// long as the session runs, since coming back to its pull request takes up what it held.
async function settleRetired($) {
  await Promise.all(
    [...retired.values()].map(async (note) => {
      if (note.dirty || !note.writtenIdle) {
        catchUp(note)
        await writeNote($, note, { strict: true }).catch(() => {})
      }
    }),
  )
}

// The notes this session holds for a pull request
function notesOf(prId) {
  return prId ? [lastNote, ...retired.values()].filter((note) => note?.pr === prId) : []
}

// Leaves this session's note idle: it holds back no other session, and still hands on its push
async function retire($) {
  if (!lastNote) return
  const note = lastNote
  lastNote = null
  // What the session knows belongs to the watch, which may have moved on to another pull request;
  // then the note keeps what it last said
  catchUp(note)
  const idle = { ...note, pending: [...note.pending], running: false, idle: true, dirty: true }
  retired.set(note.key, idle)
  await writeNote($, idle)
}

// Brings a note of the watched pull request up to what this session knows of its pushes
function catchUp(note) {
  if (note.pr !== watched?.id) return
  note.since = Math.max(note.since, knownSince)
  note.pending = [...pushes]
}

// Writes a note as it stands, its pushes included. dirty says the store has not taken what the note
// holds now, and writtenIdle whether it last took the note as idle.
// Writes to one key go out one after another, each with the note as it stands when it goes out, so
// an earlier write that the store answers late never lands over a later one.
function writeNote($, note, { strict = false } = {}) {
  note.dirty = false
  const { key } = note
  let idle = false
  const write = (noteWrites.get(key) ?? Promise.resolve())
    .then(() => {
      idle = Boolean(note.idle)
      return $.store.set(key, noteValue(note))
    })
    .then(
      () => {
        note.writtenIdle = idle
      },
      (error) => {
        note.dirty = true
        throw error
      },
    )
  const tail = write.catch(() => {})
  noteWrites.set(key, tail)
  tail.then(() => {
    if (noteWrites.get(key) === tail) noteWrites.delete(key)
  })
  return strict ? write : tail
}

function noteValue({ pr, at, since, pending = [], running, idle, deferred }) {
  const pushes = pending.filter((push) => !push.dropped).map(pushNote)
  return {
    pr,
    at,
    since,
    ...(pushes.length ? { pending: pushes } : {}),
    ...(running ? { running } : {}),
    ...(idle ? { idle } : {}),
    ...(deferred ? { deferred } : {}),
  }
}

// A push as a note hands it on, for the session that relays to apply
function pushNote({ id, at, head, shas, refs, running, doneAt }) {
  return {
    ...(id ? { id } : {}),
    at,
    head,
    ...(shas ? { shas } : {}),
    ...(refs ? { refs } : {}),
    ...(running ? { running } : {}),
    ...(typeof doneAt === 'number' ? { doneAt } : {}),
  }
}

// Whether a push of this session still holds back a poll started at now: one whose Bash call hung
// holds nothing back for long, the same as another session's in readNotes
function holds(push, now) {
  return push.running && (push.at === null || push.at >= now - RUNNING_MS)
}

function pushId(at) {
  return `${at.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// What tells one push from another: its id, or for a note written without one, its start
function pushKey(push) {
  return push.id ?? `at:${push.at}`
}

// Whether a push moved the pull request to the head GitHub shows now: once it has finished, by the
// commits it pushed, or, when its output named none, by the head having changed since it started.
// A pushed commit the head already had before is some other ref moved to it. The session that
// pushed falls back on the record's head as GitHub showed it before the push; with no head known at all, the push stays pending, and
// the head commit's date is the baseline.
function pushCounts(push, data, now, { recordHead = null } = {}) {
  const head = data.headRefOid
  // A push whose Bash call hung past the time it holds the relays back is taken as finished with
  // nothing known of what it pushed: it counts once the head moves
  if (holds(push, now) || !head) return false
  const before = push.head ?? recordHead
  if (Array.isArray(push.shas)) {
    // A pushed commit the head has may be another ref moved to it, where the pull request's branch
    // got by itself: when the output says which branch moved where, only its own branch counts
    const own = data.headRefName ? push.refs?.[data.headRefName] : null
    const named = push.refs && Object.keys(push.refs).length > 0
    const moved = named ? typeof own === 'string' && head.startsWith(own) : push.shas.some((sha) => head.startsWith(sha))
    if (before != null) return before !== head && moved
    // Without the head before it, only the pull request's own branch moving to it says the push
    // moved the head
    return typeof own === 'string' && head.startsWith(own)
  }
  return before != null && head !== before
}

// The commits a finished git push moved refs to, and the commit each branch moved to: none when it
// moved nothing, or null when its output does not say (a new branch, a quiet push)
function pushedCommits(ran) {
  const text = [ran.text, ran.result?.stdout, ran.result?.stderr].filter((t) => typeof t === 'string').join('\n')
  // The usual form (old..new  src -> dst) and --porcelain's (flag TAB src:dst TAB old..new)
  const moves = [
    ...[...text.matchAll(/\b[0-9a-f]{7,40}\.{2,3}([0-9a-f]{7,40})\s+\S+\s+->\s+(\S+)/g)].map((m) => [m[1], m[2]]),
    ...[...text.matchAll(/^[ +\-*!=]\t[^\t]*:(\S+)\t[0-9a-f]{7,40}\.{2,3}([0-9a-f]{7,40})\b/gm)].map((m) => [m[2], m[1]]),
  ]
  // Moved nothing only when no update was printed: one Bash call may run several pushes, of which
  // only the last was up to date. --porcelain says a ref already up to date with =
  if (!moves.length) return /Everything up-to-date|^=\t/m.test(text) ? { shas: [], refs: {} } : null
  // The branch each ref moved to its commit, so a push can be told to have moved the pull request's
  // own branch even with no head known before it
  const refs = Object.fromEntries(moves.map(([sha, ref]) => [ref.replace(/^refs\/heads\//, ''), sha]))
  return { shas: [...new Set(moves.map(([sha]) => sha))], refs }
}

// The head the watched pull request had as lately as this session knows: its own last poll or the
// record another session wrote since
async function headBefore($, prId) {
  if (!prId) return null
  const own = watched?.id === prId ? lastHead : null
  // A record it cannot read may hold a fresher head than this session saw, so the head is unknown
  const record = await $.store.get(KEY_PREFIX + prId).catch(() => null)
  if (record === null) return null
  if (!record?.head || !own) return record?.head ?? own
  const recordAt = record.headAt ?? record.at ?? 0
  // Two heads seen in the same millisecond cannot be told apart, so neither is the head before
  if (recordAt === lastHeadAt && record.head !== own) return null
  return recordAt > lastHeadAt ? record.head : own
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
    for (const push of [].concat(other.pending ?? [])) {
      if (typeof push?.at !== 'number') continue
      pending.push(push)
      // One left running by a session that died mid-push holds nothing back for long
      if (push.running && push.at >= note.at - RUNNING_MS) pushing = true
    }
    // A poll that left the round to another holds nothing back either: polls a few seconds apart
    // would otherwise each yield to the one before, round after round, and none would relay
    if (other.idle || other.deferred) continue
    // A note written while this one's was on its way, even in the same millisecond it was timed,
    // may have been elected without seeing it
    const landedAt = note.landedAt ?? note.at
    if (landedAt > note.at && other.at >= note.at && other.at <= landedAt) {
      defers = true
      continue
    }
    if (other.at > note.at) continue
    if (other.at < note.at - (other.running ? RUNNING_MS : ROUND_MS)) continue
    if (other.at < note.at || key < note.key) defers = true
  }
  return { defers, since, pending, pushing }
}

// Marks what is new since the last push as relayed: reviews before an approval, then the usage
// limit. A newer approval is marked with the reviews, and mentioned only if it came after them.
// Review details are fetched at delivery, once the record is written, outside the write queue
function relay($, pr, signals, record) {
  const fresh = signals.reviews.filter((r) => !record.reviews.includes(r.id)).sort((a, b) => a.at - b.at)
  if (fresh.length > 0) {
    const previous = record.approvedAt
    const approvedAt = signals.approvedAt > previous ? signals.approvedAt : 0
    record.reviews.push(...fresh.map((r) => r.id))
    if (approvedAt) record.approvedAt = approvedAt
    return [
      {
        pr,
        reviews: fresh,
        approvedAt: approvedAt > fresh[fresh.length - 1].at ? approvedAt : 0,
        undo: (r) => {
          if (approvedAt && r.approvedAt === approvedAt) r.approvedAt = previous
          const pending = fresh.map((f) => f.id)
          r.reviews = r.reviews.filter((id) => !pending.includes(id))
        },
      },
    ]
  }
  if (signals.approvedAt > record.approvedAt) {
    const approvedAt = signals.approvedAt
    const previous = record.approvedAt
    record.approvedAt = approvedAt
    return [
      {
        text:
          `Codex が PR #${pr.number} (${pr.url}) を approved にしました（${clock(approvedAt)}）。` +
          'CI の結果を確かめ、問題がなければ作業の完了を報告してください。',
        undo: (r) => {
          if (r.approvedAt === approvedAt) r.approvedAt = previous
        },
      },
    ]
  }
  if (signals.usageLimitAt > record.usageLimitAt) {
    const usageLimitAt = signals.usageLimitAt
    const previous = record.usageLimitAt
    record.usageLimitAt = usageLimitAt
    return [
      {
        toast: `PR #${pr.number}: Codex の利用上限に達し、レビューが付きません`,
        undo: (r) => {
          if (r.usageLimitAt === usageLimitAt) r.usageLimitAt = previous
        },
      },
    ]
  }
  return []
}

// Queues a prompt without waiting for it, since it resolves only when its turn starts. A prompt
// that did not enter (refused, or dropped by a hook) takes its mark back, so a later poll sends it.
function deliver($, key, { text, toast, pr, reviews, approvedAt, undo }) {
  if (toast) return $.ui.toast(toast)
  // A mark the store would not take back stays, and that prompt is not sent again
  const ready = reviews
    ? reviewPrompt($, pr, reviews, approvedAt).catch(() => reviewPromptParts(pr, reviews, approvedAt).fallback)
    : Promise.resolve(text)
  ready
    .then((text) => submit($, text))
    .then((entered) => entered || takeBack($, key, undo))
    .catch(() => {})
}

// The opening, approval note and fallback use only the review counts already read by the poll
function reviewPromptParts(pr, reviews, approvedAt) {
  const count = reviews.reduce((sum, r) => sum + r.comments, 0)
  const endpoint = `repos/${pr.owner}/${pr.name}/pulls/${pr.number}/comments`
  const text =
    `Codex が PR #${pr.number} (${pr.url}) にレビューを付けました（レビュー ${reviews.length} 件、inline コメント ${count} 件）。\n` +
    '指摘を一つずつ確かめ、妥当なものは直して push し、妥当でないものは理由を添えてそのコメントに返信してください。\n' +
    `返信は gh api ${endpoint}/<comment id>/replies -f body='...' で送れます。`
  const approval = approvedAt
    ? `\n\nなお、このレビューの後（${clock(approvedAt)}）に Codex が 👍 を付けています。指摘に対応して push しない場合は、approved とみなしてかまいません。`
    : ''
  return { text, approval, fallback: `${text}\nコメントは gh api ${endpoint} で確認してください。${approval}` }
}

// The review prompt carries its comments, or instructions to read them if details are unavailable
async function reviewPrompt($, pr, reviews, approvedAt) {
  const parts = reviewPromptParts(pr, reviews, approvedAt)
  let text = parts.text
  const { approval, fallback } = parts
  const details = await reviewDetails($, reviews).catch(() => [])
  const sections = []
  let remaining = 0
  for (const review of reviews) {
    const detail = details.find((r) => r?.databaseId === review.id)
    const nodes = Array.isArray(detail?.comments?.nodes) ? detail.comments.nodes : []
    const comments = nodes.filter((c) =>
      c?.databaseId != null && typeof c.path === 'string' && typeof c.body === 'string' && typeof c.url === 'string',
    )
    const total = Math.max(review.comments, detail?.comments?.totalCount ?? 0, comments.length)
    remaining += total
    for (const comment of comments) {
      const outdated = comment.line == null || comment.outdated
      const line = outdated ? comment.originalLine : comment.line
      sections.push({
        text: `### ${comment.path}:${line ?? '?'}${outdated ? ' (outdated)' : ''} (comment ${comment.databaseId})\n${cappedBody(comment.body)}\n${comment.url}`,
        comments: 1,
      })
    }
    if (total === 0 && typeof detail?.body === 'string') {
      const body = detail.body.replace(/<details\b[^>]*>[\s\S]*?<\/details\s*>/gi, '').trim()
      if (body) sections.push({ text: `### レビュー ${review.id}\n${cappedBody(body)}\n${detail.url}`, comments: 0 })
    }
  }
  if (sections.length === 0) {
    return fallback
  }
  const rest = (n) => n > 0 ? `\n\n残り ${n} 件のコメントは ${pr.url}/files で確認してください。` : ''
  for (const section of sections) {
    const addition = `\n\n${section.text}`
    // Leave room for the omitted count and approval so the whole prompt stays within the cap
    if (text.length + addition.length + rest(remaining - section.comments).length + approval.length > PROMPT_LIMIT) break
    text += addition
    remaining -= section.comments
  }
  return text + rest(remaining) + approval
}

// A trimmed body with a link notice when its text exceeds the per-body cap
function cappedBody(body) {
  const trimmed = body.trim()
  return trimmed.length > BODY_LIMIT ? trimmed.slice(0, BODY_LIMIT) + '…（以下省略、全文は URL で）' : trimmed
}

// Takes marks back without waiting; a store that refuses it leaves them, and says so
function takeBackAll($, key, sends, pr) {
  for (const send of sends) {
    takeBack($, key, send.undo).catch(async (error) => {
      if (watched?.id !== pr.id) return
      lastCheck = { at: await $.clock.now(), error: `mark: ${error?.message ?? error}` }
      showStatus($)
    })
  }
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
    .map((r) => ({ id: r.databaseId, nodeId: r.id, at: after(r.submittedAt), comments: r.comments?.totalCount ?? 0 }))
  return { approvedAt, usageLimitAt, reviews }
}

// The pull request, with every connection followed back until it reaches the last push: the
// head commit's date, or since when that is later
async function query($, pr, since) {
  const data = await graphql($, pr, QUERY)
  // The head comes from this first page only, so it was seen now, not once the older pages came
  const seenAt = await $.clock.now()
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
  return { data, seenAt }
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

// The comments of exactly the reviews a prompt reports, fetched only when it is delivered
async function reviewDetails($, reviews) {
  const { exitCode, stdout, stderr } = await $.process.run([
    'gh', 'api', 'graphql',
    '-f', `query=${REVIEW_QUERY}`,
    ...reviews.flatMap((r) => ['-f', `ids[]=${r.nodeId}`]),
  ])
  if (exitCode !== 0) throw new Error(stderr.trim().split('\n')[0] || `gh exited ${exitCode}`)
  const nodes = JSON.parse(stdout)?.data?.nodes
  if (!Array.isArray(nodes)) throw new Error('review details not found')
  return nodes
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

async function prune($) {
  const now = await $.clock.now()
  const cutoff = now - STALE_MS
  const own = `${POLL_PREFIX}${await sessionIdOf($)}:`
  const keys = await $.store.keys()
  await Promise.all(
    keys.map(async (key) => {
      const record = await $.store.get(key)
      if (key.startsWith(KEY_PREFIX)) {
        if (record?.at >= (record?.ended ? cutoff : cutoff - (OPEN_STALE_MS - STALE_MS))) return
        await $.store.delete(key)
      } else if (key.startsWith(own)) {
        // Only this session writes its notes, so one it no longer holds goes once the record has
        // counted what it hands on, or once stale; the delete waits for any write still going out
        if (notesOf(record?.pr).some((note) => note.key === key)) return
        if (record?.at >= ((await counted($, record)) ? now - HOUR_MS : cutoff)) return
        // A watch this session started meanwhile may have queued its note under the key, so the
        // delete looks again once the writes before it are out
        const removal = (noteWrites.get(key) ?? Promise.resolve()).then(() =>
          notesOf(record?.pr).some((note) => note.key === key) ? undefined : $.store.delete(key),
        )
        const tail = removal.catch(() => {})
        noteWrites.set(key, tail)
        tail.then(() => {
          if (noteWrites.get(key) === tail) noteWrites.delete(key)
        })
        await removal
      } else if (key.startsWith(POLL_PREFIX)) {
        // The store has no conditional delete, so another session's note is left while its pull
        // request may still hold an election: one that session rewrote between the read and the
        // delete would vanish from it. Only a stale note of a pull request that ended (or whose record
        // is gone) goes, since no session polls that one any more
        if (record?.at >= cutoff) return
        const pr = await $.store.get(KEY_PREFIX + record?.pr)
        if (pr && !pr.ended) return
        if (JSON.stringify(await $.store.get(key)) !== JSON.stringify(record)) return
        await $.store.delete(key)
      }
    }),
  )
}

// Whether the pushes a poll note hands on are in its pull request's record already
async function counted($, note) {
  const since = normalize(await $.store.get(KEY_PREFIX + note?.pr)).since
  return !(note?.since > since) && ![].concat(note?.pending ?? []).some((push) => push?.at > since)
}

function normalize(record) {
  return {
    since: record?.since ?? 0,
    head: record?.head ?? null,
    headAt: record?.headAt ?? 0,
    approvedAt: record?.approvedAt ?? 0,
    usageLimitAt: record?.usageLimitAt ?? 0,
    reviews: Array.isArray(record?.reviews) ? record.reviews : [],
    ended: record?.ended ?? null,
    at: record?.at ?? 0,
  }
}

// id is the pull request whatever the case it is spelled in, as GitHub reads owner and repository
// names: the store key, and what watches are matched by
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

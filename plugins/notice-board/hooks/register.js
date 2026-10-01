// Shares notices across the sessions on this machine: /notice posts one to every session in the
// same repository (or, with --all, to every session), each shows it above the prompt and passes
// it on to its model once, and /notice clear takes it down everywhere.

// The notices this session shows, newest first
let notices = []
let sessionId = null
// The timer that picks up other sessions' notices, kept so a later session.start can stop it
let ticker = null
// Loads run one at a time, so a tick and a command can't pass the same notice on twice
let queue = Promise.resolve()

// $.store has no atomic update, so each notice has a key of its own: posting never overwrites
// another session's notice, and clearing deletes keys instead of rewriting a shared list
const KEY_PREFIX = 'notice:'
// The notices this session has passed on to the model, kept by the host so a hot reload or a
// worker respawn does not pass them on again. Only load writes it.
const KNOWN = { plugin: 'notice-board', key: 'known' }
// How often to pick up notices other sessions posted or cleared
const TICK_MS = 60_000
// The band shows this many notices, newest first, and counts the rest
const MAX_SHOWN = 3

const USAGE = 'Usage: /notice <text> | /notice --all <text> | /notice clear'

export function register(on) {
  // Fires again on an enable or a worker respawn, which may keep this module's variables
  on('session.start', async ($, e, next) => {
    ticker?.cancel()
    notices = []
    queue = Promise.resolve()
    sessionId = await $.session.id()
    await $.command.register({
      name: 'notice',
      description: 'Post a notice to every session in this repository (--all: on this machine), or clear them',
      argumentHint: '[--all] <text> | clear',
    })
    await refresh($)
    ticker = $.clock.every(TICK_MS, () => refresh($))
    return next(e)
  })

  // /clear and compaction leave a conversation that may no longer hold the notices, so they are
  // passed on again. /clear also switches to another session id, so this session's own posts are
  // passed on too.
  on('classic.SessionStart', { source: ['clear', 'compact'] }, async ($, e, next) => {
    sessionId = await $.session.id()
    await refresh($, { forget: true })
    return next(e)
  })

  // Answers /notice, from the person or from another plugin's $.command.run (pr-relay posts
  // "main advanced" this way, since a plugin's $.store is its own)
  on('command.run', { command: 'notice' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'clear') return { text: await clear($) }
    const all = /^--all(\s|$)/.test(args)
    const text = (all ? args.slice('--all'.length) : args).trim()
    if (!text) return { text: USAGE }
    return { text: await post($, text, all) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (notices.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const rows = notices.slice(0, MAX_SHOWN).map((notice) =>
      Box({
        key: 'notice-' + notice.id,
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ dimColor: true, children: [label(notice, now)] }),
          Text({ wrap: 'truncate-end', children: [notice.text] }),
        ],
      }),
    )
    const hidden = notices.length - MAX_SHOWN
    if (hidden > 0) rows.push(Text({ key: 'notice-more', dimColor: true, children: ['+' + hidden + ' more'] }))
    const board = Box({ flexDirection: 'column', children: rows })
    // Keep what the mods after this one draw in the band
    const rest = await next(e)
    if (!rest) return board
    return Box({ flexDirection: 'column', children: [board, rest] })
  })
}

async function post($, text, all) {
  const repoKey = repoKeyOf(await $.session.repo())
  if (!all && repoKey === null) return 'Not in a git repository. Use /notice --all <text> to post to every session.'
  const postedAt = await $.clock.now()
  await $.store.set(KEY_PREFIX + postedAt + '-' + sessionId, { text, repo: all ? null : repoKey, postedAt, by: sessionId })
  await refresh($)
  return all ? 'Posted to every session on this machine.' : 'Posted to every session in this repository.'
}

// Takes down every notice this session shows; each other session tells its model at its next tick
async function clear($) {
  await refresh($)
  const cleared = notices
  await Promise.all(cleared.map((notice) => $.store.delete(KEY_PREFIX + notice.id)))
  await refresh($)
  if (cleared.length === 0) return 'No notices to clear.'
  return 'Cleared ' + cleared.length + (cleared.length === 1 ? ' notice.' : ' notices.')
}

// Loads the notices after every earlier load has settled, whether it succeeded or not, and redraws
function refresh($, options) {
  const run = queue.then(
    () => load($, options),
    () => load($, options),
  )
  queue = run.catch(() => {})
  return run.then(() => $.ui.invalidate('ui.render'))
}

// Reads the notices meant for this session, and tells the model about the ones it has not seen
// and the ones it saw that have since been cleared. forget starts from a model that has seen none.
async function load($, { forget = false } = {}) {
  const repoKey = repoKeyOf(await $.session.repo())
  const keys = (await $.store.keys()).filter((key) => key.startsWith(KEY_PREFIX))
  const values = await Promise.all(keys.map((key) => $.store.get(key)))
  const stored = new Set()
  const shown = []
  keys.forEach((key, i) => {
    const notice = values[i]
    if (!isNotice(notice)) return
    const id = key.slice(KEY_PREFIX.length)
    stored.add(id)
    if (notice.repo === null || (repoKey !== null && notice.repo === repoKey)) shown.push({ id, ...notice })
  })
  // At an equal time the later id comes first, so every session lists them alike
  shown.sort((a, b) => b.postedAt - a.postedAt || (a.id < b.id ? 1 : -1))
  notices = shown

  const known = forget ? [] : ((await $.state.get(KNOWN)).value ?? [])
  const knownIds = new Set(known.map((k) => k.id))
  // This session's own posts reach its model as the command's output
  const fresh = shown.filter((notice) => notice.by !== sessionId && !knownIds.has(notice.id)).reverse()
  const withdrawn = known.filter((k) => !stored.has(k.id))
  if (!forget && fresh.length === 0 && withdrawn.length === 0) return

  // Known before the append: a run that refuses it refuses it every time, so it is not retried
  await $.state.set(KNOWN, [
    ...known.filter((k) => stored.has(k.id)),
    ...fresh.map((notice) => ({ id: notice.id, text: notice.text })),
  ])
  if (fresh.length === 0 && withdrawn.length === 0) return
  const now = await $.clock.now()
  const lines = [
    ...fresh.map(
      (notice) =>
        'Notice to every Claude Code session ' +
        (notice.repo === null ? 'on this machine' : 'in this repository') +
        ', posted ' + ago(now - notice.postedAt) + ' ago with /notice: ' + notice.text,
    ),
    ...withdrawn.map((k) => 'This notice was cleared and no longer applies: ' + k.text),
  ]
  const text = lines.join('\n')
  const result = await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    .catch((error) => ({ deny: error instanceof Error ? error.message : String(error) }))
  // A run no plugin may shape refuses the row; the band still shows the notices
  if (result.deny !== undefined) $.ui.log('notice-board could not tell the model: ' + result.deny + '\n' + text, { to: 'debug' })
}

// Names a repository the same in each of its worktrees and clones: the origin remote as
// host/owner/name, whether it is spelled as SSH or HTTPS, with or without .git; or, with no
// remote, the main working tree's path
function repoKeyOf(repo) {
  if (!repo) return null
  if (!repo.remote) return 'path:' + repo.root
  const remote = repo.remote.trim()
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+)$/i.exec(remote)
  if (!match) return remote.toLowerCase()
  const path = match[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  return (match[1] + '/' + path).toLowerCase()
}

function isNotice(value) {
  return (
    value != null &&
    typeof value.text === 'string' &&
    typeof value.postedAt === 'number' &&
    (value.repo === null || typeof value.repo === 'string')
  )
}

function label(notice, now) {
  return 'notice' + (notice.repo === null ? ' (all)' : '') + ' ' + ago(now - notice.postedAt) + ':'
}

function ago(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h'
  return Math.floor(hours / 24) + 'd'
}

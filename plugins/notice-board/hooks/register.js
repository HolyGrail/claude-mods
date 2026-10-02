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
// The rows the host refused to add, by key, so a refusal is not retried every tick. Forgotten
// when the conversation is replaced or rewound, which may want them again.
const refused = new Set()
// The conversation as the last load read it while refusals were held, one fingerprint per message
let seen = []
// Bumped by every session.start and conversation switch, so a load begun before one doesn't record
// its refusals against the conversation that follows
let generation = 0
// Counts this module's posts, so two in the same millisecond get keys of their own
let posts = 0

// $.store has no atomic update, so each notice has a key of its own: posting never overwrites
// another session's notice, and clearing deletes keys instead of rewriting a shared list
const KEY_PREFIX = 'notice:'
// What the model was told is read back from the conversation itself, so a reload, /clear,
// compaction, /resume, /rewind and /branch each leave it right. Each notice or withdrawal is a row
// of its own, whose whole text is one of these, so a notice's body may hold anything, new lines
// that look like another row included
const TOLD = /^Notice to every Claude Code session (on this machine|in this repository), posted \d+[mhd] ago with \/notice: ([\s\S]*)$/
const WITHDRAWN = /^This notice no longer applies: ([\s\S]*)$/
// $.session.messages() returns at most this many, the newest
const WINDOW = 4096
// How often to pick up notices other sessions posted or cleared
const TICK_MS = 60_000
// The band shows this many notices, newest first, and counts the rest
const MAX_SHOWN = 3

// The session.end reasons after which this module stops; /clear, /resume and logout leave it running
const FINAL_REASONS = ['prompt_input_exit', 'other']

const USAGE = 'Usage: /notice <text> | /notice --all <text> | /notice clear'

export function register(on) {
  // Fires again on an enable or a worker respawn, which may keep this module's variables
  on('session.start', async ($, e, next) => {
    ticker?.cancel()
    // The queue stays: a load the previous start began may still be running
    notices = []
    forgetRefusals()
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

  // /clear, /resume and /branch (fork) switch to another session id, which later posts carry. The
  // conversation they leave is read at the next load: /resume installs its own only after this hook,
  // so a tick in between may tell the outgoing one, and the load after it tells the new one
  on('classic.SessionStart', { source: ['clear', 'compact', 'resume', 'fork'] }, async ($, e, next) => {
    sessionId = await $.session.id()
    forgetRefusals()
    return next(e)
  })

  // Before the model reads a prompt, the conversation it reads is brought up to date: /rewind
  // raises no event of its own, and the lines it took back are retold here
  on('prompt.submit', async ($, e, next) => {
    // A load that fails must not hold the prompt back; the next tick tries again
    await refresh($).catch(() => {})
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (FINAL_REASONS.includes(e.reason)) ticker?.cancel()
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
  posts += 1
  await $.store.set(KEY_PREFIX + postedAt + '-' + sessionId + '-' + posts, { text, repo: all ? null : repoKey, postedAt })
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
function refresh($) {
  const run_ = () => load($)
  const run = queue.then(run_, run_)
  queue = run.catch(() => {})
  return run.then(() => $.ui.invalidate('ui.render'))
}

// Reads the notices meant for this session, and tells the model about the ones its conversation
// does not hold and the ones it holds that have since been cleared
async function load($) {
  const repoKey = repoKeyOf(await $.session.repo())
  const keys = (await $.store.keys()).filter((key) => key.startsWith(KEY_PREFIX))
  const values = await Promise.all(keys.map((key) => $.store.get(key)))
  const shown = []
  keys.forEach((key, i) => {
    const notice = values[i]
    if (!isNotice(notice)) return
    const id = key.slice(KEY_PREFIX.length)
    if (notice.repo === null || (repoKey !== null && notice.repo === repoKey)) shown.push({ id, ...notice })
  })
  // At an equal time the later id comes first, so every session lists them alike
  shown.sort((a, b) => b.postedAt - a.postedAt || (a.id < b.id ? 1 : -1))
  notices = shown

  const started = generation
  const messages = await $.session.messages()
  if (refused.size > 0) {
    const now = messages.map(fingerprint)
    if (!continues(seen, now)) refused.clear()
    seen = now
  }
  const told = toldIn(messages)
  const toldTexts = new Set(told.values())
  const shownTexts = new Set(shown.map((notice) => notice.text))
  // This session's own posts too: a command's output is not part of what the model reads. Oldest
  // first, and one row for notices that read the same
  const fresh = []
  for (const notice of [...shown].reverse()) {
    const key = toldKey(notice)
    if (!told.has(key) && !refused.has(key) && !fresh.some((f) => toldKey(f) === key)) fresh.push(notice)
  }
  // Cleared, or meant for a repository this session has left; one whose text another notice shown
  // here still carries still applies
  const withdrawn = [...toldTexts].filter((text) => !shownTexts.has(text) && !refused.has('withdrawn\n' + text))
  if (fresh.length === 0 && withdrawn.length === 0) return

  const now = await $.clock.now()
  const rows = [
    ...fresh.map((notice) => ({
      key: toldKey(notice),
      text:
        'Notice to every Claude Code session ' +
        (notice.repo === null ? 'on this machine' : 'in this repository') +
        ', posted ' + ago(now - notice.postedAt) + ' ago with /notice: ' + notice.text,
    })),
    ...withdrawn.map((text) => ({ key: 'withdrawn\n' + text, text: 'This notice no longer applies: ' + text })),
  ]
  for (const row of rows) {
    const result = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: row.text }] } })
      .catch((error) => ({ deny: error instanceof Error ? error.message : String(error) }))
    if (result.deny === undefined) continue
    // A run no plugin may shape refuses the row; the band still shows the notices. A refusal met
    // before a restart or a switch is not held against what follows it.
    if (generation === started) {
      if (refused.size === 0) seen = messages.map(fingerprint)
      refused.add(row.key)
    }
    $.ui.log('notice-board could not tell the model: ' + result.deny + '\n' + row.text, { to: 'debug' })
  }
}

function forgetRefusals() {
  generation += 1
  refused.clear()
  seen = []
}

// The notices the conversation tells the model of, by key, with their text: each row this module
// added in order, a withdrawal taking back every notice of its text
function toldIn(messages) {
  const told = new Map()
  for (const message of messages) {
    if (message.role !== 'user') continue
    const added = TOLD.exec(message.text)
    if (added) {
      told.set((added[1] === 'on this machine' ? 'all' : 'repo') + '\n' + added[2], added[2])
      continue
    }
    const withdrawn = WITHDRAWN.exec(message.text)
    if (withdrawn) for (const [key, value] of told) if (value === withdrawn[1]) told.delete(key)
  }
  return told
}

// Notices of one scope that read the same are told once
function toldKey(notice) {
  return (notice.repo === null ? 'all' : 'repo') + '\n' + notice.text
}

function fingerprint(message) {
  const ids = [...message.toolUses, ...(message.toolResults ?? [])].map((t) => t.tool_use_id)
  return message.role + '\n' + ids.join(' ') + '\n' + message.text
}

// Whether now is before carried on: before's messages, less the oldest ones the capped window
// dropped, start it, so nothing before held was rewound or replaced
function continues(before, now) {
  if (before.length === 0) return true
  // Where before's newest message sits in now, tried from the newest so a repeated one doesn't hide
  // a longer match
  for (let end = now.length - 1; end >= 0; end--) {
    if (now[end] !== before[before.length - 1]) continue
    const dropped = before.length - 1 - end
    // Only a full window drops its oldest messages
    if (dropped < 0 || (dropped > 0 && now.length < WINDOW)) continue
    if (now.slice(0, end + 1).every((fp, i) => fp === before[dropped + i])) return true
  }
  return false
}

// Names a repository the same in each of its worktrees and clones: the origin remote as
// host[:port]/path, whether it is spelled as a URL (https://, ssh://) or scp-style (git@host:path),
// with or without a user or .git. The path keeps its case, which some servers tell apart. With no
// remote, or a local one (a path or file://, whose spelling may be relative), the main working
// tree's path.
function repoKeyOf(repo) {
  if (!repo) return null
  const remote = repo.remote?.trim() ?? ''
  // A host is a name or a bracketed IPv6 address
  const url = /^(?!file:)[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^/:]+)(:\d+)?\/(.+)$/i.exec(remote)
  const scp = url ? null : /^(?:[^@/]+@)?(\[[^\]]+\]|[^/:]+):(?!\/\/)(.+)$/.exec(remote)
  const parts = url ? [url[1] + (url[2] ?? ''), url[3]] : scp ? [scp[1], scp[2]] : null
  if (!parts) return 'path:' + repo.root
  return parts[0].toLowerCase() + '/' + parts[1].replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
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

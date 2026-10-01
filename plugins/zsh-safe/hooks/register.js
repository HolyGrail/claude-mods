// Lets Bash commands written the bash way run under zsh: an unmatched glob and a leading = pass
// through as text, and a timeout this machine lacks goes to gtimeout or is refused with the fix.

// nonomatch passes an unmatched glob on as text, as bash does; noequals keeps a word starting
// with = from expanding to a command's path
const PREFIX = 'setopt nonomatch noequals; '

// The Bash tool's shell, read once per session.start: its path and whether it is zsh
let shell = null
// Which timeout command that shell runs ('timeout', 'gtimeout', null for neither, undefined when
// the probe failed), probed the first time a command uses timeout, since most sessions never do
let timeoutProbe = null
// The commands as the model wrote them, by the rewritten command, so tool.check can decide on them
const originals = new Map()

// The words after which the next word is still in command position
const LEAD_WORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', 'time'])
// Characters that end a word and start a new command
const SEPARATORS = ';&|\n('
const BLANKS = ' \t'

export function register(on) {
  // Fires again on a reload, which also resets this module's variables
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    shell = readShell($)
    timeoutProbe = null
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const { path, isZsh } = await (shell ??= readShell($))
    let command = e.command

    const timeouts = command.includes('timeout') ? commandWords(command, 'timeout') : []
    if (timeouts.length > 0) {
      const available = await (timeoutProbe ??= probeTimeout($, path))
      if (available === null) {
        return {
          deny:
            `${$.plugin.name}: timeout is not installed on this machine (macOS has none). ` +
            `Run the command without it and set the Bash tool's timeout parameter (in milliseconds) instead.`,
        }
      }
      if (available === 'gtimeout') command = toGtimeout(command, timeouts)
    }
    if (isZsh && !command.startsWith(PREFIX)) command = PREFIX + command

    if (command === e.command) return next(e)
    originals.set(command, e.command)
    try {
      return await next({ ...e, command })
    } finally {
      originals.delete(command)
    }
  })

  // The permission rules see the rewritten command: `setopt ...;` is a subcommand no allow rule
  // names, and `Bash(timeout:*)` does not match gtimeout. When a rewrite alone turns an allowed
  // command into a question, decide on the command as the model wrote it; a deny on either stands.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    const original = originals.get(e.input?.command)
    if (verdict.decision !== 'ask' || original === undefined) return verdict

    const asWritten = await $.tool.check({ tool: 'Bash', input: { ...e.input, command: original } })
    return asWritten.decision === 'ask' ? verdict : asWritten
  })
}

async function readShell($) {
  // The Bash tool runs CLAUDE_CODE_SHELL when it is set, else the login shell
  const path = (await $.env.get('CLAUDE_CODE_SHELL')) || (await $.env.get('SHELL')) || '/bin/sh'
  return { path, isZsh: /(^|\/)zsh$/.test(path) }
}

async function probeTimeout($, shellPath) {
  try {
    // A login shell, so PATH includes what the profile adds (Homebrew's gtimeout)
    const { stdout } = await $.process.run(
      [shellPath, '-lc', 'for c in timeout gtimeout; do command -v "$c" >/dev/null 2>&1 && echo "$c" && break; done'],
      { timeoutMs: 10_000 },
    )
    return stdout.trim() || null
  } catch {
    return undefined
  }
}

// Where `name` stands as a command in `command`: at the start or after ; & | ( or a newline,
// outside quotes, comments and here-document bodies. A lexical scan, not a parse: a command
// inside "$(...)" or after `env` is not found.
function commandWords(command, name) {
  const found = []
  // Delimiters of here-documents whose bodies start after the current line
  const heredocs = []
  let isDelimiterNext = false
  let isCommandPosition = true
  let i = 0

  while (i < command.length) {
    const c = command[i]
    if (BLANKS.includes(c)) {
      i++
      continue
    }
    if (c === '\n' && heredocs.length > 0) {
      i = skipHeredocs(command, i + 1, heredocs.splice(0))
      isCommandPosition = true
      continue
    }
    if (SEPARATORS.includes(c)) {
      isCommandPosition = true
      i++
      continue
    }
    if (c === '#') {
      const end = command.indexOf('\n', i)
      i = end === -1 ? command.length : end
      continue
    }

    const start = i
    i = wordEnd(command, i)
    const word = command.slice(start, i)

    if (isDelimiterNext) {
      heredocs.push(unquote(word))
      isDelimiterNext = false
    } else if (word.startsWith('<<') && !word.startsWith('<<<')) {
      const delimiter = word.slice(2).replace(/^-/, '')
      if (delimiter === '') isDelimiterNext = true
      else heredocs.push(unquote(delimiter))
    }

    if (isCommandPosition && word === name) found.push(start)
    isCommandPosition = isCommandPosition && LEAD_WORDS.has(word)
  }
  return found
}

function wordEnd(command, i) {
  while (i < command.length && !BLANKS.includes(command[i]) && !SEPARATORS.includes(command[i])) {
    const c = command[i]
    if (c === '\\') {
      i += 2
    } else if (c === "'") {
      const close = command.indexOf("'", i + 1)
      i = close === -1 ? command.length : close + 1
    } else if (c === '"') {
      i++
      while (i < command.length && command[i] !== '"') i += command[i] === '\\' ? 2 : 1
      i++
    } else {
      i++
    }
  }
  return Math.min(i, command.length)
}

// Skips the bodies of the here-documents opened on the line that ended at `i`
function skipHeredocs(command, i, delimiters) {
  for (const delimiter of delimiters) {
    while (i < command.length) {
      const end = command.indexOf('\n', i)
      const line = command.slice(i, end === -1 ? command.length : end)
      i = end === -1 ? command.length : end + 1
      if (line.replace(/^\t+/, '') === delimiter) break
    }
  }
  return i
}

function unquote(word) {
  return word.replace(/['"\\]/g, '')
}

function toGtimeout(command, starts) {
  let out = command
  for (const start of starts.reverse()) out = `${out.slice(0, start)}g${out.slice(start)}`
  return out
}

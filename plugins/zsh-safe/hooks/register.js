// Lets Bash commands written the bash way run under zsh: an unmatched glob and a leading = pass
// through as text, and a timeout this machine lacks goes to gtimeout or is refused with the fix.

// nonomatch passes an unmatched glob on as text, as bash does; noequals keeps a word starting
// with = from expanding to a command's path
const PREFIX = 'setopt nonomatch noequals; '

// What the shell probe found, resolved once per session.start: whether the Bash tool's shell is
// zsh, and which timeout command it can run ('timeout', 'gtimeout', null for neither, undefined
// when the probe failed and nothing is known)
let probe = null

// The words after which the next word is still in command position
const LEAD_WORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', 'time'])
// Characters that end a word and start a new command
const SEPARATORS = ';&|\n('
const BLANKS = ' \t'

export function register(on) {
  // Fires again on a reload, which also resets this module's variables
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    probe = detect($)
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const { isZsh, timeoutCommand } = await (probe ??= detect($))
    let command = e.command

    const timeouts = commandWords(command, 'timeout')
    if (timeouts.length > 0 && timeoutCommand === null) {
      return {
        deny:
          `${$.plugin.name}: timeout is not installed on this machine (macOS has none). ` +
          `Run the command without it and set the Bash tool's timeout parameter (in milliseconds) instead.`,
      }
    }
    if (timeouts.length > 0 && timeoutCommand === 'gtimeout') command = replaceWords(command, timeouts, 'timeout', 'gtimeout')
    if (isZsh && !command.startsWith(PREFIX)) command = PREFIX + command

    return next(command === e.command ? e : { ...e, command })
  })

  // The permission rules see the rewritten command, where `setopt ...;` is a subcommand no allow
  // rule names. When that alone turns an allowed command into a question, decide on the command
  // without the prefix instead; a deny on either stands.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    const command = e.input?.command
    if (verdict.decision !== 'ask' || typeof command !== 'string' || !command.startsWith(PREFIX)) return verdict

    const unprefixed = await $.tool.check({ tool: 'Bash', input: { ...e.input, command: command.slice(PREFIX.length) } })
    return unprefixed.decision === 'ask' ? verdict : unprefixed
  })
}

async function detect($) {
  // The Bash tool runs CLAUDE_CODE_SHELL when it is set, else the login shell
  const shell = (await $.env.get('CLAUDE_CODE_SHELL')) || (await $.env.get('SHELL')) || '/bin/sh'
  const isZsh = /(^|\/)zsh$/.test(shell)
  try {
    // A login shell, so PATH includes what the profile adds (Homebrew's gtimeout)
    const { stdout } = await $.process.run(
      [shell, '-lc', 'for c in timeout gtimeout; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done'],
      { timeoutMs: 10_000 },
    )
    const found = stdout.split('\n')
    const timeoutCommand = found.includes('timeout') ? 'timeout' : found.includes('gtimeout') ? 'gtimeout' : null
    return { isZsh, timeoutCommand }
  } catch {
    return { isZsh, timeoutCommand: undefined }
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

function replaceWords(command, starts, name, replacement) {
  let out = command
  for (const start of [...starts].reverse()) out = out.slice(0, start) + replacement + out.slice(start + name.length)
  return out
}

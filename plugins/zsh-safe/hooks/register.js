// Lets Bash commands written the bash way run under zsh: an unmatched glob and a leading = pass
// through as text, and a timeout the shell lacks is refused with the fix.
//
// The options come from zdotdir/.zshenv, which every zsh Claude Code starts reads once ZDOTDIR
// points there. Commands are never rewritten, so the permission rules, the auto mode classifier
// and the transcript all see the command the model wrote.

// Whether the Bash tool's shell can run timeout (undefined when unknown), probed the first time
// a command uses timeout, since most sessions never do
let timeoutProbe = null

// The words after which the next word is still in command position
const LEAD_WORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', 'time'])
// Characters that end a word
const SEPARATORS = ';&|\n()'
const BLANKS = ' \t'
// What the probe prints, on a line of its own amid whatever the shell's startup files print
const PROBE_MARK = 'zsh-safe:timeout='

export function register(on) {
  // Fires again on a reload, which also resets this module's variables
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    timeoutProbe = null
    const zdotdir = `${$.plugin.root}/zdotdir`
    const current = await $.env.get('ZDOTDIR')
    // A reload finds ZDOTDIR already here, and the person's own value already kept
    if (current !== zdotdir) {
      await $.env.set('ZSH_SAFE_ZDOTDIR', current)
      await $.env.set('ZDOTDIR', zdotdir)
    }
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.command.includes('timeout') && runsTimeout(e.command) && (await (timeoutProbe ??= probeTimeout($))) === false) {
      return {
        deny:
          `${$.plugin.name}: timeout is not installed on this machine (macOS has none). ` +
          `Run the command without it and set the Bash tool's timeout parameter (in milliseconds) instead.`,
      }
    }
    return next(e)
  })
}

async function probeTimeout($) {
  // The Bash tool runs CLAUDE_CODE_SHELL when it is set, else the login shell; for any other
  // shell, or none, what it would pick is unknown
  const shell = (await $.env.get('CLAUDE_CODE_SHELL')) || (await $.env.get('SHELL'))
  if (shell === undefined || !/(^|\/)(zsh|bash)[^/]*$/.test(shell)) return undefined
  try {
    // Login and interactive, with bash's rc file too, so the profile's PATH and the rc file's
    // functions count, as they do in the Bash tool's snapshot of the shell
    const { stdout } = await $.process.run(
      [
        shell,
        '-lic',
        `[ -n "\${BASH_VERSION-}" ] && [ -f ~/.bashrc ] && . ~/.bashrc >/dev/null 2>&1; ` +
          `command -v timeout >/dev/null 2>&1 && echo ${PROBE_MARK}yes || echo ${PROBE_MARK}no`,
      ],
      { stdin: '', timeoutMs: 10_000 },
    )
    const answer = stdout.split('\n').find(line => line.startsWith(PROBE_MARK))?.slice(PROBE_MARK.length)
    return answer === undefined ? undefined : answer === 'yes'
  } catch {
    return undefined
  }
}

// Whether the command runs timeout as a command of its own, not one it defines as a function
function runsTimeout(command) {
  return hasCommand(command, 'timeout') && !/(^|[\s;&|({])(function\s+timeout\b|timeout\s*\(\s*\))/.test(command)
}

// Whether `name` stands as a command in `command`: at the start or after ; & | ( or a newline,
// outside quotes, $(...), comments, here-document bodies, arithmetic, [[ ]] tests, case
// statements and array values. A lexical scan, not a parse: a command inside one of those, or
// after `env`, is not found.
function hasCommand(command, name) {
  // Here-documents whose bodies start after the current line
  const heredocs = []
  // Set when `<<` or `<<-` stood alone, so the next word is its delimiter
  let stripsTabsOfNext = null
  // The word that closes a construct being skipped, `]]` or `esac`
  let skipsTo = null
  let isCommandPosition = true
  let i = 0

  while (i < command.length) {
    const c = command[i]
    if (BLANKS.includes(c)) {
      i++
    } else if (c === '\n') {
      i = skipHeredocs(command, i + 1, heredocs.splice(0))
      isCommandPosition = skipsTo === null
    } else if (c === '(' && (command[i + 1] === '(' || command[i - 1] === '=')) {
      // Arithmetic, (( ... )), or an array's values
      i = skipParens(command, i + 1)
      isCommandPosition = false
    } else if (SEPARATORS.includes(c)) {
      isCommandPosition = skipsTo === null && c !== ')'
      i++
    } else if (c === '#') {
      const end = command.indexOf('\n', i)
      i = end === -1 ? command.length : end
    } else {
      const start = i
      i = wordEnd(command, i)
      const word = command.slice(start, i)

      if (stripsTabsOfNext !== null) {
        heredocs.push({ delimiter: unquote(word), stripsTabs: stripsTabsOfNext })
        stripsTabsOfNext = null
      } else {
        const at = word.search(/(?<!<)<<(?!<)/)
        if (at !== -1) {
          const rest = word.slice(at + 2)
          const stripsTabs = rest.startsWith('-')
          const token = stripsTabs ? rest.slice(1) : rest
          // An empty token means the delimiter is the next word; '' or "" is an empty delimiter
          if (token === '') stripsTabsOfNext = stripsTabs
          else heredocs.push({ delimiter: unquote(token), stripsTabs })
        }
      }

      if (skipsTo !== null) {
        if (word === skipsTo) skipsTo = null
        isCommandPosition = false
        continue
      }
      if (isCommandPosition && word === '[[') skipsTo = ']]'
      else if (isCommandPosition && word === 'case') skipsTo = 'esac'
      if (isCommandPosition && word === name) return true
      isCommandPosition = isCommandPosition && LEAD_WORDS.has(word)
    }
  }
  return false
}

function wordEnd(command, i) {
  while (i < command.length && !BLANKS.includes(command[i]) && !SEPARATORS.includes(command[i])) i = skipToken(command, i)
  return Math.min(i, command.length)
}

// Steps over one character, or one quoted string or substitution starting at `i`
function skipToken(command, i) {
  const c = command[i]
  if (c === '\\') return i + 2
  if (c === "'") return command[i - 1] === '$' ? skipEscaped(command, i + 1, "'") : skipLiteral(command, i + 1)
  if (c === '"') return skipDoubleQuoted(command, i + 1)
  if (c === '`') return skipEscaped(command, i + 1, '`')
  if (c === '$' && command[i + 1] === '(') return skipParens(command, i + 2)
  return i + 1
}

// Each skip starts just inside its opening and returns the index just past its close

function skipLiteral(command, i) {
  const close = command.indexOf("'", i)
  return close === -1 ? command.length : close + 1
}

function skipEscaped(command, i, close) {
  while (i < command.length && command[i] !== close) i += command[i] === '\\' ? 2 : 1
  return i + 1
}

function skipDoubleQuoted(command, i) {
  while (i < command.length && command[i] !== '"') {
    if (command[i] === '\\') i += 2
    else if (command[i] === '$' && command[i + 1] === '(') i = skipParens(command, i + 2)
    else if (command[i] === '`') i = skipEscaped(command, i + 1, '`')
    else i++
  }
  return i + 1
}

function skipParens(command, i) {
  let depth = 1
  while (i < command.length) {
    const c = command[i]
    if (c === '(') depth++
    if (c === ')' && --depth === 0) return i + 1
    i = c === '(' || c === ')' ? i + 1 : skipToken(command, i)
  }
  return i
}

// Skips the bodies of the here-documents opened on the line that ended at `i`
function skipHeredocs(command, i, heredocs) {
  for (const { delimiter, stripsTabs } of heredocs) {
    while (i < command.length) {
      const end = command.indexOf('\n', i)
      const line = command.slice(i, end === -1 ? command.length : end)
      i = end === -1 ? command.length : end + 1
      if ((stripsTabs ? line.replace(/^\t+/, '') : line) === delimiter) break
    }
  }
  return i
}

function unquote(word) {
  return word.replace(/['"\\]/g, '')
}

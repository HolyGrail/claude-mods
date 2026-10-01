// Lets Bash commands written the bash way run under zsh: an unmatched glob and a leading = pass
// through as text, and a timeout the shell lacks is refused with the fix.

// Under zsh, nonomatch passes an unmatched glob on as text, as bash does, and noequals keeps a
// word starting with = from expanding to a command's path. The guard leaves other shells alone,
// so nothing has to guess which shell the Bash tool picks.
const PREFIX = '[ -n "$ZSH_VERSION" ] && setopt nonomatch noequals; '

// Whether the Bash tool's shell can run timeout (undefined when the probe failed), probed the
// first time a command uses timeout, since most sessions never do
let timeoutProbe = null
// The calls running with a rewritten command, by tool_use_id: the command as the model wrote it,
// the rewritten one, and whether a PreToolUse hook asked or denied
const calls = new Map()

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
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command
    if (command.includes('timeout') && runsTimeout(command) && (await (timeoutProbe ??= probeTimeout($))) === false) {
      return {
        deny:
          `${$.plugin.name}: timeout is not installed on this machine (macOS has none). ` +
          `Run the command without it and set the Bash tool's timeout parameter (in milliseconds) instead.`,
      }
    }
    if (command.startsWith(PREFIX)) return next(e)

    const call = { original: command, rewritten: PREFIX + command, isHookDecided: false }
    calls.set(e.tool_use_id, call)
    try {
      return await next({ ...e, command: call.rewritten })
    } finally {
      calls.delete(e.tool_use_id)
    }
  })

  // A PreToolUse hook's ask or deny is the engine's answer, not the prefix's doing: keep it
  on('classic.PreToolUse', { tool: 'Bash' }, async ($, e, next) => {
    const decided = await next(e)
    const call = calls.get(e.tool_use_id)
    if (call !== undefined && (decided.ask !== undefined || decided.deny !== undefined)) call.isHookDecided = true
    return decided
  })

  // The permission rules see the rewritten command, where the prefix's `[` and `setopt` are
  // subcommands no allow rule names. Decide on the command as the model wrote it as well: its
  // deny stands, and its allow stands in for an ask the prefix alone caused.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    const call = callChecked(e)
    if (call === undefined || verdict.decision === 'deny' || (verdict.decision === 'ask' && call.isHookDecided)) return verdict

    const asWritten = await $.tool.check({ tool: 'Bash', input: { ...e.input, command: call.original } })
    if (asWritten.decision === 'deny') return asWritten
    return verdict.decision === 'ask' && asWritten.decision === 'allow' ? asWritten : verdict
  })
}

// The rewritten call a check is about: by its id on a real call, else (a plugin's query) by the
// command; none when a hook changed the command since this module rewrote it
function callChecked(e) {
  const command = e.input?.command
  const call = e.tool_use_id !== undefined ? calls.get(e.tool_use_id) : [...calls.values()].find(c => c.rewritten === command)
  return call?.rewritten === command ? call : undefined
}

async function probeTimeout($) {
  // The Bash tool runs CLAUDE_CODE_SHELL when it is set, else the login shell
  const shell = (await $.env.get('CLAUDE_CODE_SHELL')) || (await $.env.get('SHELL')) || '/bin/sh'
  try {
    // Login and interactive, so the profile's PATH and the rc file's functions count, as they do
    // in the Bash tool's snapshot of the shell
    const { stdout } = await $.process.run(
      [shell, '-lic', `command -v timeout >/dev/null 2>&1 && echo ${PROBE_MARK}yes || echo ${PROBE_MARK}no`],
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
// outside quotes, comments, here-document bodies, arithmetic, [[ ]] tests and array values. A
// lexical scan, not a parse: a command inside $(...) or after `env` is not found.
function hasCommand(command, name) {
  // Here-documents whose bodies start after the current line
  const heredocs = []
  // Set when `<<` or `<<-` stood alone, so the next word is its delimiter
  let stripsTabsOfNext = null
  let isCommandPosition = true
  let i = 0

  while (i < command.length) {
    const c = command[i]
    if (BLANKS.includes(c)) {
      i++
    } else if (c === '\n') {
      i = skipHeredocs(command, i + 1, heredocs.splice(0))
      isCommandPosition = true
    } else if (c === '(' && (command[i + 1] === '(' || command[i - 1] === '=')) {
      // Arithmetic, (( ... )), or an array's values
      i = skipParens(command, i + 1)
      isCommandPosition = false
    } else if (SEPARATORS.includes(c)) {
      isCommandPosition = c !== ')'
      i++
    } else if (c === '#') {
      const end = command.indexOf('\n', i)
      i = end === -1 ? command.length : end
    } else {
      const start = i
      i = wordEnd(command, i)
      const word = command.slice(start, i)

      if (word === '[[') {
        const end = command.indexOf(']]', i)
        i = end === -1 ? command.length : end + 2
        isCommandPosition = false
        continue
      }
      if (stripsTabsOfNext !== null) {
        heredocs.push({ delimiter: unquote(word), stripsTabs: stripsTabsOfNext })
        stripsTabsOfNext = null
      } else {
        const at = word.search(/(?<!<)<<(?!<)/)
        if (at !== -1) {
          const rest = word.slice(at + 2)
          const stripsTabs = rest.startsWith('-')
          const delimiter = unquote(stripsTabs ? rest.slice(1) : rest)
          if (delimiter === '') stripsTabsOfNext = stripsTabs
          else heredocs.push({ delimiter, stripsTabs })
        }
      }

      if (isCommandPosition && word === name) return true
      isCommandPosition = isCommandPosition && LEAD_WORDS.has(word)
    }
  }
  return false
}

function wordEnd(command, i) {
  while (i < command.length && !BLANKS.includes(command[i]) && !SEPARATORS.includes(command[i])) {
    const c = command[i]
    if (c === '\\') i += 2
    else if (c === "'") i = command[i - 1] === '$' ? skipEscaped(command, i + 1, "'") : skipLiteral(command, i + 1)
    else if (c === '"') i = skipDoubleQuoted(command, i + 1)
    else if (c === '`') i = skipEscaped(command, i + 1, '`')
    else if (c === '$' && command[i + 1] === '(') i = skipParens(command, i + 2)
    else i++
  }
  return Math.min(i, command.length)
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
    if (c === '\\') i += 2
    else if (c === "'") i = skipLiteral(command, i + 1)
    else if (c === '"') i = skipDoubleQuoted(command, i + 1)
    else if (c === '`') i = skipEscaped(command, i + 1, '`')
    else {
      if (c === '(') depth++
      if (c === ')' && --depth === 0) return i + 1
      i++
    }
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

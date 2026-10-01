import { type Engine, expect, mock, test } from 'claude-code/testing'

const PREFIX = 'setopt nonomatch noequals; '

// The stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const

// Starts a session whose Bash tool runs `shell`, where the shell probe finds the timeout commands
// in `timeouts` (or fails, with 'probe fails'), and returns the commands that reach the Bash tool
async function start(
  $: Engine,
  on: On,
  shell: string,
  timeouts: readonly string[] | 'probe fails' = [],
) {
  mock.env(on, { SHELL: shell })
  on('session.start', () => ({ cwd: '/work' }))
  on('process.run', () => {
    if (timeouts === 'probe fails') throw new Error('cannot start')
    return {
      value: { exitCode: 0, stdout: timeouts.map(c => `${c}\n`).join(''), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  const ran: string[] = []
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    ran.push(e.command as string)
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  await $.session.start(START)
  return ran
}

test('prefixes setopt under zsh, so an unmatched glob and a leading = run as bash would', async ($, on) => {
  const ran = await start($, on, '/bin/zsh', ['gtimeout'])

  await $.tool.call({ tool: 'Bash', command: 'grep -r --include=*.ts foo .' })
  await $.tool.call({ tool: 'Bash', command: 'echo ===' })

  expect(ran).toEqual([`${PREFIX}grep -r --include=*.ts foo .`, `${PREFIX}echo ===`])
})

test('leaves the command alone under bash where timeout is installed', async ($, on) => {
  const ran = await start($, on, '/bin/bash', ['timeout', 'gtimeout'])
  await $.tool.call({ tool: 'Bash', command: 'echo ===' })
  await $.tool.call({ tool: 'Bash', command: 'timeout 5 make' })
  expect(ran).toEqual(['echo ===', 'timeout 5 make'])
})

test('does not prefix a command that already starts with the setopt', async ($, on) => {
  const ran = await start($, on, '/opt/homebrew/bin/zsh', ['timeout'])
  await $.tool.call({ tool: 'Bash', command: `${PREFIX}ls` })
  expect(ran).toEqual([`${PREFIX}ls`])
})

test('runs timeout as gtimeout where only gtimeout is installed, in command position only', async ($, on) => {
  const ran = await start($, on, '/bin/bash', ['gtimeout'])

  await $.tool.call({ tool: 'Bash', command: 'timeout 5 make' })
  await $.tool.call({ tool: 'Bash', command: 'cd app && timeout 30s npm test | tail -5; timeout 1 true' })
  await $.tool.call({ tool: 'Bash', command: 'if timeout 2 ping -c1 host; then echo up; fi' })
  // Arguments, quotes, comments and here-document bodies are not commands
  await $.tool.call({ tool: 'Bash', command: 'grep timeout log.txt' })
  await $.tool.call({ tool: 'Bash', command: `echo "a; timeout 5"; echo 'b | timeout 5'` })
  await $.tool.call({ tool: 'Bash', command: 'make # then timeout 5 it' })
  await $.tool.call({ tool: 'Bash', command: "cat <<'EOF' > run.sh\ntimeout 5 make\nEOF\necho done" })

  expect(ran).toEqual([
    'gtimeout 5 make',
    'cd app && gtimeout 30s npm test | tail -5; gtimeout 1 true',
    'if gtimeout 2 ping -c1 host; then echo up; fi',
    'grep timeout log.txt',
    `echo "a; timeout 5"; echo 'b | timeout 5'`,
    'make # then timeout 5 it',
    "cat <<'EOF' > run.sh\ntimeout 5 make\nEOF\necho done",
  ])
})

test('refuses timeout with the fix where neither timeout nor gtimeout is installed', async ($, on) => {
  const ran = await start($, on, '/bin/zsh', [])

  const denied = await $.tool.call({ tool: 'Bash', command: 'sleep 1 && timeout 5 make' })
  await $.tool.call({ tool: 'Bash', command: 'grep timeout log.txt' })

  expect(denied.deny).toContain("Bash tool's timeout parameter")
  expect(ran).toEqual([`${PREFIX}grep timeout log.txt`])
})

test('passes timeout through where the shell probe failed', async ($, on) => {
  const ran = await start($, on, '/bin/bash', 'probe fails')
  await $.tool.call({ tool: 'Bash', command: 'timeout 5 make' })
  expect(ran).toEqual(['timeout 5 make'])
})

test('decides on the command without the prefix when the prefix alone makes it a question', async ($, on) => {
  // Rules beneath that allow echo and deny rm, and ask about anything else
  on('tool.check', ($, e) => {
    const { command } = e.input as { command: string }
    if (command.startsWith('rm ')) return { decision: 'deny', reason: 'rm is denied' }
    return command.startsWith('echo ') ? { decision: 'allow', rule: 'Bash(echo:*)' } : { decision: 'ask' }
  })
  await start($, on, '/bin/zsh')

  const allowed = await $.tool.check({ tool: 'Bash', input: { command: `${PREFIX}echo ===` } })
  const denied = await $.tool.check({ tool: 'Bash', input: { command: `${PREFIX}rm -rf build` } })
  const asked = await $.tool.check({ tool: 'Bash', input: { command: `${PREFIX}make` } })
  const unprefixed = await $.tool.check({ tool: 'Bash', input: { command: 'make' } })

  expect(allowed).toEqual({ decision: 'allow', rule: 'Bash(echo:*)' })
  expect(denied.decision).toBe('deny')
  expect(asked.decision).toBe('ask')
  expect(unprefixed.decision).toBe('ask')
})

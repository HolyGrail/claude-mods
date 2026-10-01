import { type Engine, expect, mock, test } from 'claude-code/testing'

const PREFIX = 'setopt nonomatch noequals; '

// The stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

type World = {
  shell: string
  // The timeout commands the shell probe finds, or 'probe fails'
  timeouts?: readonly string[] | 'probe fails'
}

// Starts a session in `world` and returns what reaches the engine: each Bash command run, and
// how many times the shell was probed
async function start($: Engine, on: On, { shell, timeouts = [] }: World, hold?: Hold) {
  const seen = { ran: [] as string[], probes: 0 }
  mock.env(on, { SHELL: shell })
  on('session.start', () => ({ cwd: '/work' }))
  on('process.run', () => {
    seen.probes++
    if (timeouts === 'probe fails') throw new Error('cannot start')
    return {
      value: { exitCode: 0, stdout: timeouts.map(c => `${c}\n`).join(''), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('tool.call', { tool: 'Bash' }, async ($, e) => {
    const command = e.command as string
    seen.ran.push(command)
    await hold?.(command)
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return seen
}

// Holds each call where the engine would run it, until released
type Hold = (command: string) => Promise<void>

// Asks the permission decision on `command` while its call is held where the engine decides it
async function decisionWhileRunning($: Engine, command: string, held: { next: () => Promise<[string, () => void]> }) {
  const running = $.tool.call({ tool: 'Bash', command })
  const [rewritten, release] = await held.next()
  const { decision } = await $.tool.check({ tool: 'Bash', input: { command: rewritten } })
  release()
  await running
  return decision
}

test('prefixes setopt under zsh, so an unmatched glob and a leading = run as bash would', async ($, on) => {
  const seen = await start($, on, { shell: '/bin/zsh' })

  await $.tool.call({ tool: 'Bash', command: 'grep -r --include=*.ts foo .' })
  await $.tool.call({ tool: 'Bash', command: 'echo ===' })
  await $.tool.call({ tool: 'Bash', command: `${PREFIX}ls` })

  expect(seen.ran).toEqual([`${PREFIX}grep -r --include=*.ts foo .`, `${PREFIX}echo ===`, `${PREFIX}ls`])
  // No command used timeout, so the shell was never started
  expect(seen.probes).toBe(0)
})

test('leaves the command alone under bash where timeout is installed', async ($, on) => {
  const seen = await start($, on, { shell: '/bin/bash', timeouts: ['timeout', 'gtimeout'] })
  await $.tool.call({ tool: 'Bash', command: 'echo ===' })
  await $.tool.call({ tool: 'Bash', command: 'timeout 5 make' })
  expect(seen.ran).toEqual(['echo ===', 'timeout 5 make'])
})

test('runs timeout as gtimeout where only gtimeout is installed, in command position only', async ($, on) => {
  const seen = await start($, on, { shell: '/bin/bash', timeouts: ['gtimeout'] })

  await $.tool.call({ tool: 'Bash', command: 'timeout 5 make' })
  await $.tool.call({ tool: 'Bash', command: 'cd app && timeout 30s npm test | tail -5; timeout 1 true' })
  await $.tool.call({ tool: 'Bash', command: 'if timeout 2 ping -c1 host; then echo up; fi' })
  // Arguments, quotes, comments and here-document bodies are not commands
  await $.tool.call({ tool: 'Bash', command: 'grep timeout log.txt' })
  await $.tool.call({ tool: 'Bash', command: `echo "a; timeout 5"; echo 'b | timeout 5'` })
  await $.tool.call({ tool: 'Bash', command: 'make # then timeout 5 it' })
  await $.tool.call({ tool: 'Bash', command: "cat <<'EOF' > run.sh\ntimeout 5 make\nEOF\necho done" })

  expect(seen.ran).toEqual([
    'gtimeout 5 make',
    'cd app && gtimeout 30s npm test | tail -5; gtimeout 1 true',
    'if gtimeout 2 ping -c1 host; then echo up; fi',
    'grep timeout log.txt',
    `echo "a; timeout 5"; echo 'b | timeout 5'`,
    'make # then timeout 5 it',
    "cat <<'EOF' > run.sh\ntimeout 5 make\nEOF\necho done",
  ])
  // Probed once, on the first command that used timeout
  expect(seen.probes).toBe(1)
})

test('refuses timeout with the fix where neither timeout nor gtimeout is installed', async ($, on) => {
  const seen = await start($, on, { shell: '/bin/zsh' })

  const denied = await $.tool.call({ tool: 'Bash', command: 'sleep 1 && timeout 5 make' })
  await $.tool.call({ tool: 'Bash', command: 'grep timeout log.txt' })

  expect(denied.deny).toContain("Bash tool's timeout parameter")
  expect(seen.ran).toEqual([`${PREFIX}grep timeout log.txt`])
})

test('passes timeout through where the shell probe failed', async ($, on) => {
  const seen = await start($, on, { shell: '/bin/bash', timeouts: 'probe fails' })
  await $.tool.call({ tool: 'Bash', command: 'timeout 5 make' })
  expect(seen.ran).toEqual(['timeout 5 make'])
})

test('decides on the command as the model wrote it when the rewrite alone makes it a question', async ($, on) => {
  // Rules beneath that allow echo and timeout, deny rm, and ask about anything else
  on('tool.check', ($, e) => {
    const { command } = e.input as { command: string }
    if (command.includes('rm ')) return { decision: 'deny', reason: 'rm is denied' }
    if (/^(echo|timeout) /.test(command)) return { decision: 'allow', rule: 'Bash(echo:*)' }
    return { decision: 'ask' }
  })
  let arrive: (arrival: [string, () => void]) => void = () => {}
  const held = { next: () => new Promise<[string, () => void]>(resolve => (arrive = resolve)) }
  const seen = await start($, on, { shell: '/bin/zsh', timeouts: ['gtimeout'] }, command =>
    new Promise(release => arrive([command, () => release()])),
  )

  const decisions = []
  for (const command of ['echo ===', 'timeout 5 echo hi', 'make', 'echo a; rm -rf build']) {
    decisions.push(await decisionWhileRunning($, command, held))
  }

  expect(seen.ran[1]).toBe(`${PREFIX}gtimeout 5 echo hi`)
  expect(decisions).toEqual(['allow', 'allow', 'ask', 'deny'])
  // Once the call has run, the rewritten command is decided as written
  expect((await $.tool.check({ tool: 'Bash', input: { command: `${PREFIX}echo ===` } })).decision).toBe('ask')
})

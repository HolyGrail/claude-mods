import { type Engine, expect, mock, test } from 'claude-code/testing'

const PREFIX = '[ -n "$ZSH_VERSION" ] && setopt nonomatch noequals; '

// The stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

// Holds a call where the engine would run it, until released
type Hold = (command: string) => Promise<void>

// Starts a session whose shell has timeout or not (or whose probe fails), and returns what reaches
// the engine: each Bash command run, and how many times the shell was probed
async function start($: Engine, on: On, timeout: 'installed' | 'missing' | 'probe fails', hold?: Hold) {
  const seen = { ran: [] as string[], probes: 0 }
  mock.env(on, { SHELL: '/bin/zsh' })
  on('session.start', () => ({ cwd: '/work' }))
  on('process.run', () => {
    seen.probes++
    if (timeout === 'probe fails') throw new Error('cannot start')
    // Startup files may print before the probe's answer
    const stdout = `Welcome back\nzsh-safe:timeout=${timeout === 'installed' ? 'yes' : 'no'}\n`
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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

async function run($: Engine, command: string) {
  return $.tool.call({ tool: 'Bash', command })
}

test('prefixes the setopt, so under zsh an unmatched glob and a leading = run as bash would', async ($, on) => {
  const seen = await start($, on, 'missing')

  await run($, 'grep -r --include=*.ts foo .')
  await run($, 'echo ===')
  await run($, `${PREFIX}ls`)

  expect(seen.ran).toEqual([`${PREFIX}grep -r --include=*.ts foo .`, `${PREFIX}echo ===`, `${PREFIX}ls`])
  // No command used timeout, so the shell was never started
  expect(seen.probes).toBe(0)
})

test('refuses a timeout command with the fix where the shell has no timeout', async ($, on) => {
  const seen = await start($, on, 'missing')

  for (const command of [
    'timeout 5 make',
    'cd app && timeout 30s npm test | tail -5',
    'if timeout 2 ping -c1 host; then echo up; fi',
    '(timeout 1 true)',
    'cat <<EOF > a\nbody\nEOF\ntimeout 5 make',
  ]) {
    expect((await run($, command)).deny).toContain("Bash tool's timeout parameter")
  }
  expect(seen.ran).toEqual([])
  // Probed once, on the first command that used timeout
  expect(seen.probes).toBe(1)
})

test('runs commands where timeout is no command of their own', async ($, on) => {
  const seen = await start($, on, 'missing')
  const commands = [
    'grep timeout log.txt',
    `echo "a; timeout 5"; echo 'b | timeout 5'`,
    `printf "%s\\n" "$(printf "%s" "one; timeout 5")"`,
    `echo $'it\\'s; timeout 5'`,
    'make # then timeout 5 it',
    "cat <<'EOF' > run.sh\ntimeout 5 make\nEOF",
    "cat<<'EOF' > run.sh\ntimeout 5 make\nEOF",
    "cat 0<<EOF > run.sh\ntimeout 5 make\n\tEOF\ntimeout 1 make\nEOF",
    'cat <<-EOF > run.sh\n\ttimeout 5 make\n\tEOF',
    'timeout=5; echo $(( timeout * 1000 ))',
    'n=$(( timeout + 1 )); (( timeout > 1 ))',
    '[[ -n $x && timeout == "$y" ]] && echo same',
    'steps=(build timeout test); echo $steps',
    'timeout() { perl -e "alarm shift; exec @ARGV" "$@"; }; timeout 5 make',
  ]
  for (const command of commands) await run($, command)
  expect(seen.ran).toEqual(commands.map(command => PREFIX + command))
})

test('passes timeout through where the shell has it', async ($, on) => {
  const seen = await start($, on, 'installed')
  await run($, 'timeout 5 make')
  expect(seen.ran).toEqual([`${PREFIX}timeout 5 make`])
})

test('passes timeout through where the shell probe failed', async ($, on) => {
  const seen = await start($, on, 'probe fails')
  await run($, 'timeout 5 make')
  expect(seen.ran).toEqual([`${PREFIX}timeout 5 make`])
})

test('decides on the command as the model wrote it, keeping every deny and a hook asking', async ($, on) => {
  // Rules beneath: echo is allowed, and any prefixed command too (as `Bash(*)` would), except that
  // curl is denied as written; anything else is a question. A PreToolUse hook asks about "confirm".
  on('tool.check', ($, e) => {
    const { command } = e.input as { command: string }
    if (command.startsWith('curl ')) return { decision: 'deny', reason: 'curl is denied' }
    if (command.startsWith('echo ') || command.startsWith(`${PREFIX}curl `)) return { decision: 'allow' }
    return { decision: 'ask' }
  })
  on('classic.PreToolUse', { tool: 'Bash' }, ($, e) => ((e.command as string).includes('confirm') ? { ask: 'please confirm' } : {}))

  // Each call is held where the engine decides it, while the test asks for the decision
  let arrive: (command: string) => void = () => {}
  let release: () => void = () => {}
  await start($, on, 'installed', command => {
    arrive(command)
    return new Promise(resolve => (release = resolve))
  })
  async function decisionOn(command: string) {
    const arrived = new Promise<string>(resolve => (arrive = resolve))
    const running = run($, command)
    const { decision } = await $.tool.check({ tool: 'Bash', input: { command: await arrived } })
    release()
    await running
    return decision
  }

  expect(await decisionOn('echo ===')).toBe('allow')
  expect(await decisionOn('make')).toBe('ask')
  expect(await decisionOn('curl example.com')).toBe('deny')
  expect(await decisionOn('echo confirm')).toBe('ask')
  // Once the call has run, the rewritten command is decided as written
  expect((await $.tool.check({ tool: 'Bash', input: { command: `${PREFIX}echo ===` } })).decision).toBe('ask')
})

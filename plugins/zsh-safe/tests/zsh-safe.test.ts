import { type Engine, expect, mock, test } from 'claude-code/testing'

// The stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

type World = {
  // The process environment, which the module reads and writes
  env?: Record<string, string>
  timeout?: 'installed' | 'missing' | 'probe fails'
}

// Starts a session in `world` and returns what reaches the engine: the environment as the module
// left it, each Bash command run, and how many times the shell was probed
async function start($: Engine, on: On, { env = { SHELL: '/bin/zsh' }, timeout = 'missing' }: World = {}) {
  const seen = { env: new Map(Object.entries(env)), ran: [] as string[], probes: 0 }
  on('env.get', ($, e) => ({ value: seen.env.get(e.name) }))
  on('env.set', ($, e) => {
    if (e.value === undefined) seen.env.delete(e.name)
    else seen.env.set(e.name, e.value)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('process.run', () => {
    seen.probes++
    if (timeout === 'probe fails') throw new Error('cannot start')
    // Startup files may print before the probe's answer
    const stdout = `Welcome back\nzsh-safe:timeout=${timeout === 'installed' ? 'yes' : 'no'}\n`
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    seen.ran.push(e.command as string)
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return seen
}

async function run($: Engine, command: string) {
  return $.tool.call({ tool: 'Bash', command })
}

test("points ZDOTDIR at the plugin's .zshenv and keeps the person's own for it to hand back", async ($, on) => {
  const seen = await start($, on, { env: { SHELL: '/bin/zsh', ZDOTDIR: '/Users/me/.config/zsh' } })

  expect(seen.env.get('ZDOTDIR')).toMatch(/\/zdotdir$/)
  expect(seen.env.get('ZSH_SAFE_ZDOTDIR')).toBe('/Users/me/.config/zsh')

  // A reload finds ZDOTDIR already pointing here, and keeps the person's value as it was
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.env.get('ZSH_SAFE_ZDOTDIR')).toBe('/Users/me/.config/zsh')
})

test('leaves nothing to hand back when the person has no ZDOTDIR', async ($, on) => {
  const seen = await start($, on)
  expect(seen.env.get('ZDOTDIR')).toMatch(/\/zdotdir$/)
  expect(seen.env.has('ZSH_SAFE_ZDOTDIR')).toBe(false)
})

test('runs every command as the model wrote it', async ($, on) => {
  const seen = await start($, on)
  await run($, 'grep -r --include=*.ts foo .')
  await run($, 'echo ===')
  expect(seen.ran).toEqual(['grep -r --include=*.ts foo .', 'echo ==='])
  // No command used timeout, so the shell was never started
  expect(seen.probes).toBe(0)
})

test('refuses a timeout command with the fix where the shell has no timeout', async ($, on) => {
  const seen = await start($, on)

  for (const command of [
    'timeout 5 make',
    'cd app && timeout 30s npm test | tail -5',
    'if timeout 2 ping -c1 host; then echo up; fi',
    '(timeout 1 true)',
    '[[ -f a ]] && timeout 5 make',
    'case $x in a) echo a;; esac; timeout 5 make',
    'cat <<EOF > a\nbody\nEOF\ntimeout 5 make',
  ]) {
    expect((await run($, command)).deny).toContain("Bash tool's timeout parameter")
  }
  expect(seen.ran).toEqual([])
  // Probed once, on the first command that used timeout
  expect(seen.probes).toBe(1)
})

test('runs commands where timeout is no command of their own', async ($, on) => {
  const seen = await start($, on)
  const commands = [
    'grep timeout log.txt',
    `echo "a; timeout 5"; echo 'b | timeout 5'`,
    `printf "%s\\n" "$(printf "%s" "one; timeout 5")"`,
    `echo $'it\\'s; timeout 5'`,
    `steps=($'it\\'s ) ; timeout 5')`,
    'make # then timeout 5 it',
    "cat <<'EOF' > run.sh\ntimeout 5 make\nEOF",
    "cat<<'EOF' > run.sh\ntimeout 5 make\nEOF",
    "cat 0<<EOF > run.sh\ntimeout 5 make\n\tEOF\ntimeout 1 make\nEOF",
    'cat <<-EOF > run.sh\n\ttimeout 5 make\n\tEOF',
    "cat <<''\ntimeout 5 make\n\necho done",
    'timeout=5; echo $(( timeout * 1000 ))',
    'n=$(( timeout + 1 )); (( timeout > 1 ))',
    '[[ -n $x && timeout == "$y" ]] && echo same',
    '[[ "]] && timeout 5" == x ]] || echo ok',
    'case ok in (timeout) echo bad;; (*) echo ok;; esac',
    'case $x in\n  timeout|slow) echo slow;;\nesac',
    'steps=(build timeout test); echo $steps',
    'timeout() { perl -e "alarm shift; exec @ARGV" "$@"; }; timeout 5 make',
  ]
  for (const command of commands) await run($, command)
  expect(seen.ran).toEqual(commands)
})

test('runs timeout where the shell has it', async ($, on) => {
  const seen = await start($, on, { timeout: 'installed' })
  await run($, 'timeout 5 make')
  expect(seen.ran).toEqual(['timeout 5 make'])
})

test('runs timeout where whether the shell has it is unknown', async ($, on) => {
  const seen = await start($, on, { timeout: 'probe fails' })
  await run($, 'timeout 5 make')
  expect(seen.ran).toEqual(['timeout 5 make'])
})

test('does not probe a shell the Bash tool would not run', async ($, on) => {
  const seen = await start($, on, { env: { SHELL: '/opt/homebrew/bin/fish' } })
  await run($, 'timeout 5 make')
  expect(seen.ran).toEqual(['timeout 5 make'])
  expect(seen.probes).toBe(0)
})

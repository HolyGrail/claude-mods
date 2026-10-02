import { type Engine, expect, mock, test } from 'claude-code/testing'

// The stub registrar a test function receives as its second argument
type On = Parameters<typeof mock.clock>[0]

// What the Bash tool answers for one command: its output and whether it failed
type Answer = { text: string; isError?: true }

// Starts a session with `env` as the process environment, where the Bash tool answers each
// command with `answer`, and returns what reaches the engine: the environment as the module left
// it, and each Bash command run
async function start($: Engine, on: On, env: Record<string, string> = {}, answer = (command: string): Answer => ({ text: command })) {
  const seen = { env: new Map(Object.entries(env)), ran: [] as string[] }
  on('env.get', ($, e) => ({ value: seen.env.get(e.name) }))
  on('env.set', ($, e) => {
    if (e.value === undefined) seen.env.delete(e.name)
    else seen.env.set(e.name, e.value)
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    const command = e.command as string
    seen.ran.push(command)
    const { text, isError } = answer(command)
    return { result: { stdout: text, stderr: '', interrupted: false }, text, isError } as never
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  return seen
}

async function run($: Engine, command: string) {
  return $.tool.call({ tool: 'Bash', command })
}

test("points ZDOTDIR at the plugin's .zshenv and keeps the person's own for it to hand back", async ($, on) => {
  const seen = await start($, on, { ZDOTDIR: '/Users/me/.config/zsh' })

  expect(seen.env.get('ZDOTDIR')).toMatch(/\/zdotdir$/)
  expect(seen.env.get('ZSH_SAFE_ZDOTDIR')).toBe('/Users/me/.config/zsh')

  // A reload finds ZDOTDIR at the folder it set, and keeps the person's value as it was; so does
  // one after an update, which moves the plugin's folder
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.env.get('ZSH_SAFE_ZDOTDIR')).toBe('/Users/me/.config/zsh')
  seen.env.set('ZDOTDIR', '/cache/zsh-safe/0.0.9/zdotdir')
  seen.env.set('ZSH_SAFE_DIR', '/cache/zsh-safe/0.0.9/zdotdir')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(seen.env.get('ZSH_SAFE_ZDOTDIR')).toBe('/Users/me/.config/zsh')
  expect(seen.env.get('ZDOTDIR')).toMatch(/\/zdotdir$/)
  expect(seen.env.get('ZDOTDIR')).not.toBe('/cache/zsh-safe/0.0.9/zdotdir')
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
  await run($, 'timeout 5 make')
  expect(seen.ran).toEqual(['grep -r --include=*.ts foo .', 'echo ===', 'timeout 5 make'])
})

test('tells the model the fix when a command fails for want of timeout', async ($, on) => {
  await start($, on, {}, command =>
    command.startsWith('zsh')
      ? { text: 'Exit code 127\n(eval):1: command not found: timeout', isError: true }
      : { text: 'Exit code 127\nbash: line 1: timeout: command not found', isError: true },
  )

  for (const command of ['zsh: timeout 5 make', 'bash: timeout 5 make']) {
    const ran = await run($, command)
    expect(ran.context?.at(-1)).toContain("Bash tool's timeout parameter")
  }
})

test('leaves other results alone', async ($, on) => {
  await start($, on, {}, command =>
    command === 'fails'
      ? { text: 'Exit code 1\nmake: *** No rule to make target', isError: true }
      : command === 'missing script'
        ? { text: 'Exit code 127\n(eval):1: command not found: timeout.sh', isError: true }
        : { text: 'zsh:1: command not found: timeout' },
  )

  // Another failure, another missing command whose name starts with timeout, and output that
  // only mentions the message
  expect((await run($, 'fails')).context).toBeUndefined()
  expect((await run($, 'missing script')).context).toBeUndefined()
  expect((await run($, 'cat log.txt')).context).toBeUndefined()
})

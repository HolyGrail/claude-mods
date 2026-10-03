# Repository Guidelines

## Project Structure & Module Organization

Claude Code plugins live under `plugins/<name>/`: `usage-meter`, `notice-board`, `pr-relay`, and `zsh-safe`. Each plugin contains:

- `.claude-plugin/plugin.json` for metadata.
- `hooks/hooks.json` for module registration and `hooks/register.js` exporting `register(on)`.
- `tests/<name>.test.ts`, `tsconfig.json`, and a Japanese `README.md`.

`plugins/zsh-safe/zdotdir/.zshenv` supplies shell configuration; usage-meter generates SVG inline. Register new plugins in root `.claude-plugin/marketplace.json` and bump the affected plugin's manifest version for user-visible changes. Consult `CLAUDE.md` for architecture details and keep guidance consistent.

## Build, Test, and Development Commands

There is no `package.json` or build step: Claude Code runs hook modules as plain JavaScript. From the affected plugin's directory, run:

```bash
claude plugin test            # Run *.test.ts and *.test.tsx tests
claude plugin validate .      # Validate the manifest and inspect hook/API usage
npx -y -p typescript tsc -p .  # Type-check tests
```

Type checking requires the untracked `.claude-plugin/types/` declarations referenced by `tsconfig.json`. It does not check `hooks/register.js`; validate that module with `claude plugin validate`, and read the hooks and `$` calls it lists to make sure they are the ones you meant.

For a live session, run `claude --plugin-dir ./plugins/usage-meter` from the repository root.

## The Claude Code Mod Runtime

Mods run on an early-access Claude Code API that is not documented publicly. This section is what an agent other than Claude Code needs to know before changing a hooks module.

`register(on)` runs once per load. `on(event, matcher?, hook)` adds a hook, and every hook has the shape `async ($, e, next) => result`:

- `e` is the event's input, a plain frozen value.
- `next(e)` runs the plugins beneath this one and then Claude Code's own behavior, resolving to the event's result. A hook that returns without calling `next` answers the event itself; `next({ ...e, x })` rewrites what the rest of the chain sees.
- `$` is the engine interface, each call spelled noun then method (`$.store.get(key)`). The module runs in a sandbox with no Node and no DOM: no `fs`, `child_process`, `process.env`, `fetch` or `setTimeout`. Everything outside the module goes through `$`.
- A hook that throws is skipped and the chain goes on without it.
- Module-level variables are the module's own state. A reload (an edit, a worker respawn, re-enabling the plugin) starts the module fresh, and `session.start` can also fire again on a module whose variables survived, so `session.start` resets them.

### Events This Repository Hooks

| Event | Matcher | What it is |
| --- | --- | --- |
| `session.start` | none | The session is ready. Awaited before the first prompt, so `$.tool.register` and `$.command.register` here are listed from turn one. Start timers here. |
| `session.end` | none | `e.reason`: `prompt_input_exit` and `other` are final; `clear`, `resume` and `logout` are not. |
| `classic.SessionStart` | `{ source: ['resume', 'clear', 'fork'] }` | The settings hook of that name. `/resume`, `/clear` and `/branch` switch the conversation, and its session id, without a new `session.start`. |
| `tool.call` | `{ tool: 'Bash' }` or `{ tool: 'mcp__<plugin>__<name>' }` | A tool call; for Bash, `e.command` is the command. Return `{ deny: reason }` to block it, or `await next(e)` to run it and read the result (`ran.text`, `ran.isError`, `ran.deny`). A plugin answers its own tool by returning `{ result: text }`. |
| `ui.render` | `{ component: 'AbovePrompt' }` | The band above the prompt. `const { Box, Text, Button } = $.ui.resolve(e)` gives the elements of the surface drawing it (`e.surface`). Return a tree, or `next(e)` when there is nothing to draw; put your line above `await next(e)` so later mods still draw. |
| `prompt.submit` | none | A prompt as submitted. |
| `command.run` | `{ command }` | A slash command the plugin registered. |

### `$` Calls This Repository Uses

| Call | Notes |
| --- | --- |
| `$.clock.now()` | Epoch ms. Use it rather than `Date.now()`, which tests cannot control. |
| `$.clock.after(ms, fn)`, `$.clock.every(ms, fn)` | Timers; each returns an object with `cancel()`. They die with the module. |
| `$.store.get(key)`, `.set(key, value)`, `.delete(key)`, `.keys()` | A JSON store per plugin, shared by every session on the machine. There is no atomic update, compare-and-set or snapshot: write only keys your session owns, and expect other sessions to write between your read and your write. |
| `$.state.get(key)` | Per-session values typed by the plugin's `types/index.d.ts` contract. |
| `$.process.run(argv, init?)` | Runs a host command by argv, with no shell. Resolves `{ exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }`. |
| `$.fs.read(path)`, `$.fs.list(dir)` | Files; `list` answers `{ name, kind, size, mtimeMs, isLink }[]`. |
| `$.env.get(name)`, `$.env.set(name, value)` | The process environment. |
| `$.session.id()`, `.cwd()`, `.repo()`, `.usage()`, `.messages()` | Facts about the session. |
| `$.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })` | Adds a row the model reads and the person does not see as typed. |
| `$.prompt.submit({ text })` | Queues a prompt that starts its own turn once the session is idle. It resolves only when that turn starts, so a hook of the running turn must never await it: the turn would wait on itself. Call it from a `$.clock` timer. |
| `$.command.register(...)`, `$.command.run({ command, args })` | Slash commands. `run` reaches another plugin's command and rejects for an unknown name; like `prompt.submit`, it waits for the session to be idle. |
| `$.tool.register({ name, description, inputSchema })` | A tool the model can call, listed as `mcp__<plugin>__<name>` and answered by a `tool.call` hook on that name. |
| `$.ui.status(text)`, `$.ui.toast(text)`, `$.ui.log(text)` | Status line (`undefined` clears it), toast, debug log. |
| `$.ui.invalidate('ui.render')` | Asks for a redraw after the module's own state changed. |

### The Authoritative Declarations

Every event and call, with doc comments and examples, is declared in `plugins/<name>/.claude-plugin/types/claude-code/index.d.ts` (about 15,000 lines; the testing kit is the `declare module 'claude-code/testing'` block near the end). Grep it for the name you need (`'tool.call'`, `run: (`, `ProcessRunResult`, `mock`) and read the declaration it lands on rather than the whole file. The folder is not in git: a person regenerates it from an interactive Claude Code session with `/plugin-types plugins/<name>/.claude-plugin/types`. If it is missing for the plugin you work on, copy another plugin's folder rather than guessing at the API.

## Desktop App Integration

Verified in a live desktop session on 2026-10-03:

- The app exposes `mcp__ccd_pr__get_status`, `mcp__ccd_pr__bind_pr`, `mcp__ccd_pr__set_monitor`, `mcp__ccd_pr__unbind_pr` and `mcp__ccd_pr__set_auto_merge` in the model's tool list. Mods can find them through `$.tool.list()` (`ToolInfo[]`, each with `name`) and call them through `$.tool.call()`. Terminal sessions have none of these tools.
- `$.tool.call({ tool: 'mcp__ccd_pr__get_status' })` takes no arguments and reads the app's cache without a GitHub request. It goes through the tool's permission check; the live call returned immediately without a dialog. It resolves to `{ text, result, isError? }` or `{ deny }`, and rejects for a missing tool or an aborted call.
- `get_status` puts JSON in `text`: `{ bound, pr, checks, mergeable, mergeStateStatus, mergeQueue, monitor, otherBoundPrs }`. `pr` is the most recently bound PR and has `number`, `url`, `repo` (`owner/name`), `host`, `title`, `state`, `draft`, `base` and `head`. `otherBoundPrs` entries have only `number`, `repo` and `state`; their GitHub URLs are `https://github.com/<repo>/pull/<number>`. States are case-insensitive `open`, `merged` or `closed`. Nothing bound means `bound: false` with no `pr`; tolerate any missing field. pr-relay supports only `github.com`, so ignore primaries on other hosts.
- When a PR's Auto-fix is on, the app's CI monitor wakes the session through `prompt.submit` with `e.origin.kind === 'sdk'` and text starting with `<ci-monitor-event>`. These prompts carry CI failures, merge conflicts and review comments quoted in full with their `comment_id`s.

## Coding Style & Naming Conventions

Match existing JavaScript and TypeScript: two-space indentation, single quotes, no semicolons, and trailing commas in multiline structures. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and kebab-case plugin directories. Keep runtime hooks in JavaScript. No formatter or linter is configured.

Write user-facing READMEs in Japanese; use English for comments, test descriptions, and commit messages.

Keep `hooks/register.js` free of dependencies and of imports from outside the plugin. Match the surrounding comment density: a comment says why, in full sentences. When behavior changes, update the tests, the plugin's `README.md` and its section of `CLAUDE.md` in the same change.

## Testing Guidelines

Use `test`, `expect`, and `mock` from `claude-code/testing`. Name files `*.test.ts` or `*.test.tsx`, with descriptions stating observable behavior. Use `mock.clock` for deterministic timing and reuse plugin-specific helpers, such as usage-meter's `stubSession`/`stubStore` or pr-relay's `stubWorld`, for shared-state scenarios.

Tests run against the real engine. Each test receives `$`, which raises events into the plugin under test, and `on`, which stubs what the plugin's `$` calls reach:

```ts
import { expect, mock, test } from 'claude-code/testing'

test('what the plugin does', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 1, 12) })
  mock.env(on, { HOME: '/home' })
  // A stub is named after the `$` call as `noun.method` and answers { value }
  on('store.get', ($, e) => ({ value: undefined }))
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  // A stub of an event answers the event's result
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
  await clock.settle()        // run the timers that are due
  await clock.advance(60_000) // move time on and run what falls due
})
```

- `$` raises `$.session.start`, `$.session.end`, `$.tool.call({ tool: 'Bash', command })`, `$.classic.SessionStart({ source: 'resume' })` and `$.ui.mount({ plugin, component, surface, props })`.
- `on` stubs `session.id`, `session.cwd`, `store.*`, `process.run`, `fs.*`, `prompt.submit`, `ui.toast`, `ui.status`, `ui.render` and the rest; `mock.env` stubs the environment.
- `mock.clock(on, { now })` fixes time and returns `{ settle, advance }`. Never sleep in a test.

Add regression coverage for changed behavior, especially session restarts, store synchronization, and terminal/Desktop rendering. No numerical coverage threshold is configured. Run the relevant plugin checks before submitting code changes.

## Commit & Pull Request Guidelines

Follow history with short English imperative subjects, such as `Share readings through a key per session`. Use commit bodies to explain non-obvious behavior or tradeoffs.

PRs should describe the problem, resulting behavior, and validation performed. Link relevant issues when available; include screenshots or terminal examples for visible changes. Update the plugin README when behavior or limitations change.

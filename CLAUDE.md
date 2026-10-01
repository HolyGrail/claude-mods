# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A collection of Claude Code mods: plugins under `plugins/<name>/` whose hooks are function hooks (a JS module exporting `register(on)`), listed in `hooks/hooks.json` under `"modules"`. The repo root is also a plugin marketplace: `.claude-plugin/marketplace.json` lists every plugin, so a new plugin needs an entry there, and a user-visible change should bump `version` in that plugin's `plugin.json` so `claude plugin update` treats it as a new release. There is no package.json or build step; the module runs as plain JS inside Claude Code. The plugins are `plugins/usage-meter` and `plugins/notice-board`.

User-facing docs (README.md) are written in Japanese; code comments, commit messages and test names are in English.

## Commands

Run from each plugin's directory (e.g. `plugins/usage-meter`):

```bash
claude plugin test               # runs every *.test.ts / *.test.tsx under the folder; exits 1 on failure
claude plugin validate .         # checks the manifest and lists the hooks and $ APIs the module uses
npx -y -p typescript tsc -p .    # type check (no TypeScript in the repo; npx fetches it)
```

To try the mod in a live session, run `claude --plugin-dir ./plugins/usage-meter` from the repo root.

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which holds the `claude-code` type declarations; that `types/` directory is not in git. The config has no `checkJs`, so `tsc` checks only the tests: `hooks/register.js` itself is never type-checked, and `claude plugin validate` is the only static check on it.

## Testing approach

Tests import `test`, `expect` and `mock` from `claude-code/testing`. Each test gets `$` (drives events into the module: `$.session.start`, `$.session.measure`, `$.ui.mount`, …) and `on` (stubs the host side: `session.usage`, `session.id`, `store.*`, `ui.render`). `mock.clock(on, { now })` fixes time. Shared helpers `stubSession` / `stubStore` back `$.store` with a `Map` so tests can assert on, or pre-seed, what other sessions saved. Assertions find rendered nodes with `ui.find({ type, text })`.

## usage-meter architecture

`hooks/register.js` draws a band above the prompt (`ui.render` for `AbovePrompt`) with meters for context, the 5-hour limit and the 7-day limit. It always calls `next(e)` and stacks its line above whatever later mods draw.

State lives in module-level variables, which may survive a re-fired `session.start` (enable or worker respawn), so `session.start` resets them and cancels the previous ticker.

Rate limits are per account, so readings are shared across all sessions on the machine through `$.store`, and that sharing is the subtle part:

- Each session writes only its own key, `reading:<sessionId>`, holding `{ at, limits }`, because `$.store` has no atomic update. Every session displays the newest reading among all keys (`scan`), with ties broken by key so all sessions agree.
- At startup, a shared reading always wins over `$.session.usage()`'s snapshot; the snapshot is saved only when no shared reading exists.
- A 60 s ticker (`$.clock.every`) re-scans the store and refreshes countdowns and time markers.
- Key cleanup: on a final `session.end` (`prompt_input_exit` / `other` only; `/clear`, `/resume` and logout keep running), a session deletes its key unless it holds the newest reading, in which case it marks it `ended: true` so others may delete it once something newer exists. `prune` also deletes non-readings and anything older than `STALE_MS` (8 days).
- `/clear`, `/resume` and `/branch` (fork) switch session id mid-module, handled in `classic.SessionStart`: the old key is released as if ended and writes move to the new id. Compaction keeps the same key.

Rendering: SVG gauge when `e.surface === 'desktop'`, otherwise a text bar sized against `props.bodyColumns` (dropped entirely when the line won't fit). Color rules and thresholds are in the README and the constants at the top of `register.js`.

## notice-board architecture

`hooks/register.js` answers `/notice` (registered in `session.start`), stores each notice under its own key `notice:<postedAt>-<sessionId>-<count>` holding `{ text, repo, postedAt }`, and draws the newest three above the prompt. `repo` is null for `--all`; otherwise it is the origin remote normalized to `host[:port]/path` (URL and scp-style spellings alike, bracketed IPv6 hosts included, host lowercased, path case kept; `path:<main working tree>` with no remote or a local one, whose spelling may be relative), so every worktree and clone of a repository matches.

- A 60 s ticker re-reads the store. Notices the model has not been told are appended once with `$.session.append`; ones it was told that are no longer shown here (cleared, or for a repository the session left) are appended as withdrawn, unless a notice still shown carries the same text. The posting session is told too: a command's output is not what the model reads. What the model knows lives in `$.state` (`notice-board.known`, typed in `types/index.d.ts`) and only `load` writes it, so a hot reload doesn't repeat it; `/clear`, compaction and `/resume` set `forgetNext`, so the next `prompt.submit` or `/notice` (never a tick, which may still see the outgoing conversation) tells the conversation everything again; a fork does not. A refused append is not retried: the API's refusals (a run no plugin may shape, a plugin's deny) don't change between ticks.
- Every load goes through one queue (`refresh`), so a tick and a command can't tell the model twice. The queue survives a re-fired `session.start`, and a final `session.end` cancels the ticker.
- Other plugins post with `$.command.run({ command: 'notice', args })`, since `$.store` is per plugin.
- The test kit never routes a plugin's `$.session.append` to the test's hooks; the call fails, and the mod logs the untold lines to the debug log, which the tests read through a `ui.log` stub.

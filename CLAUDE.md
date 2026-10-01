# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A collection of Claude Code mods: plugins under `plugins/<name>/` whose hooks are function hooks (a JS module exporting `register(on)`), listed in `hooks/hooks.json` under `"modules"`. There is no package.json or build step; the module runs as plain JS inside Claude Code. The plugins are `plugins/usage-meter` and `plugins/zsh-safe`.

User-facing docs (README.md) are written in Japanese; code comments, commit messages and test names are in English.

## Commands

Run from the plugin's directory (e.g. `plugins/usage-meter`):

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

## zsh-safe architecture

`hooks/register.js` rewrites Bash calls in `tool.call`: it prefixes `[ -n "$ZSH_VERSION" ] && setopt nonomatch noequals; `, so the shell itself decides whether it is zsh, and denies a `timeout` in command position when the shell lacks it. `hasCommand` finds it by a lexical scan that skips quotes, `$(...)`, comments, here-document bodies, arithmetic, `[[ ]]` and array values; a false positive costs a denied call, so the module never rewrites the command's text beyond the prefix. Whether the shell has `timeout` is probed once, with a login interactive shell, the first time a command uses it.

`tool.check` runs after `tool.call`'s rewrite, so the permission rules see the prefixed command, where `[` and `setopt` are subcommands no allow rule names: without the module's `tool.check` hook `Bash(echo:*)` stops matching `echo ===`. While a rewritten call runs, the module keeps the model's command by `tool_use_id`; the hook also decides on that original, and a deny on either wins, an ask the prefix alone caused gives way to the original's allow, and an ask or deny from a PreToolUse hook (seen by the module's `classic.PreToolUse` hook) is kept.

Tests cannot call `$.tool.check` from their own hooks, and their `$.tool.call` raises no `tool.check`, so the permission test holds the call beneath the plugin and asks from the test body; that query carries no `tool_use_id`, which is why the module also finds a running call by its rewritten command.

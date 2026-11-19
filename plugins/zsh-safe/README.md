# zsh-safe

English | [日本語](README.ja.md)

A Claude Code mod that lets Bash commands Claude writes in bash style run as they are under macOS's zsh.

```text
$ zsh -c 'grep -r --include=*.ts foo .'
zsh:1: no matches found: --include=*.ts
```

The model sees the failure, adds quotes and runs it again.
It gets its result in the end, but each time at the cost of one more tool round trip, and the error output stays in the context.

## What it does

- **zsh options**: turns on `setopt nonomatch noequals` in the zsh that Claude Code starts. A glob that matches no file is passed on as a plain string, as in bash (`nonomatch`), and a leading `=` in a word is no longer expanded to a command's path (`noequals`).
- **timeout**: when a command fails with `command not found: timeout`, adds a note to the result that only the model sees. It says that `timeout` is missing and that the Bash tool's own `timeout` parameter can stand in for it only when the time limit applies to the whole command, and leaves how to rewrite the command to the model. It does not touch how the command runs.

## How it works

zsh reads `$ZDOTDIR/.zshenv` every time it starts.
At the start of the session, this mod points the `ZDOTDIR` environment variable of the Claude Code process at the `zdotdir/` shipped with the mod.
`zdotdir/.zshenv` first sets `ZDOTDIR` back to its original value (or unsets it if it was unset), reads the person's `.zshenv`, and then runs `setopt`.
`.zprofile` and `.zshrc` are read as before, from the restored `ZDOTDIR`.

It applies only to the shells Claude Code starts.
Writing the same `setopt` in `.zshrc` would also work for Claude's Bash, but it would also take away, in the interactive shell the person uses every day, the zsh safeguard that stops a glob with no match before it runs.

The command string is not rewritten.
The permission check, the auto mode classifier and the transcript all see the command as the model wrote it.
Prefixing the command with `setopt …;` makes an allow rule such as `Bash(echo:*)` stop matching, since it does not cover the `setopt` subcommand (checked with `claude -p`: `echo ===` was denied).

## Limitations

- The `setopt` in `zdotdir/.zshenv` runs after the person's `.zshenv` and before `.zprofile` and `.zshrc`. So it has no effect where `.zshrc` undoes it, for example with `unsetopt nonomatch`.
- It has no effect where `/etc/zshenv` sets `ZDOTDIR` again. zsh runs `/etc/zshenv` first and then looks for `$ZDOTDIR/.zshenv`, so the bundled `.zshenv` is not read.
- `ZDOTDIR` applies to every zsh Claude Code starts from then on. That includes, besides the Bash tool, scripts that start zsh from a settings hook. A zsh started from within a command does not feel it, since `ZDOTDIR` is back to the original by then.
- Disabling or uninstalling the mod does not restore that process's `ZDOTDIR`. The mods API has no event announcing an unload. Restarting Claude Code restores it.
- It does not prevent the `timeout` failure. With `make clean && timeout 30 make`, `make clean` runs and then it stops. That is the same behavior as without the mod; what changes is that the model receives how to fix it in the same round trip.
- Parsing the command before it runs to deny `timeout` is not done. A lexical scan mistakes variable names, here-document lines and `case` patterns, and stops correct commands. Looking at the error text of the result catches it however it is written, as with `env timeout` or inside `$( )`.
- Nor is `timeout` rewritten. With `perl -e 'alarm shift; exec @ARGV'` the exit code on timeout changes from `timeout`'s 124 to SIGALRM's 142, and durations with units such as `5s`, fractions, and the `-k` / `-s` options cannot be reproduced.

## Usage

It has been checked on Claude Code v2.1.286.

### Install

At the Claude Code prompt, run these three in order.

```text
/plugin marketplace add HolyGrail/claude-mods
/plugin install zsh-safe@claude-mods
/reload-plugins
```

It takes effect from the next zsh that starts.
### Update

Pull in the marketplace's information, then update the mod.
The update takes effect after Claude Code restarts.

```bash
claude plugin marketplace update claude-mods
```

```bash
claude plugin update zsh-safe@claude-mods
```

What to keep in mind is in the [repository README](../../README.md).

### Try it without installing

From the root of the cloned repository, start Claude Code like this.

```bash
claude --plugin-dir ./plugins/zsh-safe
```

To always load the local code, put this directory's absolute path in `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`.

## Tests

```bash
cd plugins/zsh-safe
claude plugin test
```

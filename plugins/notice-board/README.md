# notice-board

English | [日本語](README.ja.md)

A mod that delivers notices, per repository, to the Claude Code sessions running at the same time on the machine.
A change of circumstances such as "CI is paused, so only the Codex review needs checking" no longer has to be typed into each session.

```text
notice 2h: CI is paused, check the Codex review only
notice (all) 1d: Rate limits are tight this week
```

## Usage

```text
/notice <text>          post to every session of the same repository
/notice --all <text>    post to every session on the machine, whatever the repository
/notice clear           clear every notice shown in this session's band
```

A notice stays after the session that posted it ends.
It has no expiry and goes away only when `/notice clear` is run.
The band shows the time since each notice was posted, so an old one is plain to see.

The Claude Code versions the mod runs on are the same as for [usage-meter](../usage-meter/README.md#usage).

### Install

At the Claude Code prompt, run these three in order.

```text
/plugin marketplace add HolyGrail/claude-mods
/plugin install notice-board@claude-mods
/reload-plugins
```

How to update, and what to keep in mind, is in the [repository README](../../README.md).

### Try it without installing

From the root of the cloned repository, start Claude Code like this.

```bash
claude --plugin-dir ./plugins/notice-board
```

To always load the local code, put this directory's absolute path in `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`.

## How notices arrive

Each session reads the notices again every 60 seconds.
A notice posted in another session reaches the band within a minute at the latest.

The model is told each notice once only, by adding one row to the conversation.
The row is added the moment the next turn begins.
That is after the prompt has joined the conversation and before the first request is sent.
The band shows the notice at once, but the model learns of it only from the next turn.
A notice that arrives in the middle of a long turn is not told to the model during that turn either.

It looks as if the row could be added sooner.
But the model reads the conversation when a request is sent, so adding it between turns does not change when it is read.
Added in the middle of a turn, the row lands in the middle of the response.
A server-side tool such as advisor holds its call and its result within one assistant message.
If a row lands between them, the API refuses every later request, and the conversation can no longer be used.
Up to version 0.2 the row was added every 60 seconds, so this actually happened.

Nothing is written to the system prompt.
Writing there would invalidate the prompt cache every time the notices change.
When a notice the model was told is cleared by `/notice clear`, or no longer applies because the session moved to another repository, the withdrawal is told once as well.
Untold, the model would keep following a notice that no longer applies.
While another notice with the same text is still shown, however, no withdrawal is told.

The model of the session that posted is told through the same route.
In an interactive session, a command's output does not enter the conversation the model reads.

Which notices were told is read back from the conversation itself.
The mod adds one row to the conversation per notice and per withdrawal, walks those rows from the start of the conversation, and matches what was told against what was withdrawn.
It reads the conversation in its Messages API form (`$.session.messages({ as: 'api' })`).
The form of rows returned with no argument does not include the rows the mod added.
Up to version 0.2, which read that form, the mod judged every time that the notice was not told yet, and kept adding the same notice.
Each row ends with `(notice-board ref …)`. This is a mark made from the text under a secret value kept per machine, and a row whose mark does not match (such as a prompt typed by hand with the same wording) is not taken as the mod's.
The unmarked rows of version 0.1 are read only for the notices that session recorded 0.1 as having told.
The notices themselves are also read again every 60 seconds and at each `/notice`, to show them in the band, but the conversation is read and the model told only at the start of a turn.
So even when the conversation is replaced or shrinks, the next turn tells what fits the conversation as it now stands.

- After `/clear` and compaction no rows are left in the conversation, so whatever is shown now is told again
- A conversation loaded with `/resume` or `--resume` is told only what it lacks. If a notice told in the loaded conversation has since been cleared, its withdrawal is told
- When `/rewind` or the restore picker rewinds the conversation and the rows go with it, they are told again at the start of the next turn
- A conversation split off with `/branch` carries over the rows of the original, so nothing is told twice
- Reloading the mod loses nothing, since the mod keeps no record of its own

`/resume` loads the new conversation after the event the mod receives, so a turn that begins in between may tell the original conversation when it reads.
The new conversation is told at its next turn.

## What counts as the same repository

The origin URLs are compared after being brought to the form `host/owner/name`.
`git@github.com:owner/app` and `https://github.com/owner/app.git` are the same repository.
The host name's case is ignored, but the path's case is not, since some Git servers tell paths apart by case.
The port number is kept as well, so repositories on different ports of the same host count as different.
Worktrees of the same repository, and other clones of it, all receive the same notices.
A repository with no origin, or whose origin is a local path or a `file://` URL, is compared by the path of its main working tree.
A local origin can be written as a relative path such as `../upstream.git`, so the same spelling may point at different repositories.

## Posting from other mods

`$.store` is separate for each mod, so other mods cannot write the notice keys.
Another mod posts by calling `/notice` through `$.command.run`.

```js
await $.command.run({ command: 'notice', args: 'CI is paused, check the Codex review only' })
```

`$.command.run` runs once the session is idle, so a post may be minutes late.

## Limitations

`$.store` has no atomic update, so each notice has a key of its own, `notice:<id>`.
A post never overwrites another notice.
A notice posted while `/notice clear` runs, however, may be left uncleared.

Whether a notice was told is judged by its scope (a repository or the whole machine) and its text.
Two notices shown with the same scope and text are told to the model only once.
`$.session.messages()` returns only the newest 4096 messages, so a row told before them counts as missing from the conversation and is told again.
So that a withdrawal can still be told when a told row has dropped out of sight, because the conversation passed 4096 messages or compaction summarized it, the notices told in each conversation are also kept in `$.store` as `told:<session ID>`.
This record serves only withdrawals; when the row of a notice still shown drops out of sight, it is told again.
The records of conversations not loaded for 8 days are deleted.

When telling the model is refused (a run where plugins cannot change the conversation, or a refusal by a plugin above), it is not retried within the same conversation.
Neither changes at the next attempt. The notice stays in the band, and the row that could not be told is left in the debug log.
After the conversation is replaced or rewound, and after the mod is reloaded, it is tried once more.

## Tests

```bash
cd plugins/notice-board
claude plugin test
```

The test kit takes the mod's `$.session.append` and records it with `mock.session(on)`.
The tests take that row in a `session.append` hook (`{ door: 'note' }`) and check what is passed to the model.
The tests' `$.session.messages({ as: 'api' })` returns the row folded, as a text block, into the user message beside it, as the engine does.
The rows form does not include the added rows.
Turns begin with `$.turn.start`.
`/clear`, `/resume` and `/rewind` are reproduced by the tests replacing the conversation.

# status-board

English | [日本語](README.ja.md)

A Claude Code mod that shows, as a "status board" in a pane beside the conversation, what this session is aiming for, how far it has come and what it is asking the person.
It also shows where things stand in one line, in the band above the prompt.

```text
● In progress (3/6) Draw the band · 23:41  [ Status board ]
```

In a long session, where you are in the plan, what you last asked for and what has been decided can no longer be told without scrolling back through the conversation.
Tool output and response text pile up in the conversation too, burying the prompts and decisions among them.
The status board is the whole of that conversation summed up by the model.
The record it was summed up from is folded away under the board as a history by prompt.

## Status board

The board is a short piece of Markdown with these five headings.

```text
## Goal
- Show the session's flow in the band and the pane
## Where things stand
- Finished fixing the band's colors
- Now reworking the pane
## Decided
- Build from the transcript (so it can be rebuilt when enabled mid-session)
## Open / waiting on you
- Whether to rewrite the README this time
## Next step
- Fix the tests, then the README
```

Under the board comes the line `As of HH:MM · summarized by the model`.
If something has happened, or a turn has ended, since the board was written, ` · activity since` follows, and when the tokens it took are known, ` · read 323k / output 490`.
The board is the model's summary, so its wording and what it keeps or leaves out are up to the model.
To check against the original record, open the cards by prompt with `Show history`.

### When the model is asked

The summary is made by having a model that carries over the session's conversation (`$.model.fork`) answer once, without tools.
This model sees up to the final answer of the turn that just ended.
A question awaiting the person's decision is often written in the final answer, and the summary at the end of the turn puts it straight into the board's waiting-on-you heading.
The model is asked only in these three cases.

- **When a turn ends with an answer**: summarizes again if the pane is open and shown. It is not asked while the pane is closed, or for a pane that could not be placed
- **When the pane is opened**: summarizes only when the pane could be placed, there is no board or it is stale (the `activity since` state), and the conversation's cache can be taken as still warm. It is taken as warm while a turn runs, or within 5 minutes of the end of the last turn
- **When the button is pressed**: `Create the status board` or `Update the status board` summarizes at any time. When the cache cannot be taken as warm, the label gets ` (cache may be cold)`

Only one summary runs at a time; meanwhile the button reads `Summarizing…`, and pressing it does nothing.
If a turn ends meanwhile, the running summary may not include that answer, so once it is done it summarizes once more.
On a failure the previous board stays, and `Could not summarize: <reason>` appears under the button.
The board is saved per session and comes back as it was after a restart or `/resume`.
A conversation split off with `/branch` starts with no board.
Boards not written for 8 days are deleted.

### Rough cost

The summary reads the main conversation's cache, so it is cheap while the cache is warm.
One run measured in the desktop app took 5.9 seconds, with 321,578 tokens read from the cache, 1,063 tokens of new input and 490 tokens of output.
Once the cache has expired, the whole conversation is read again as ordinary input, which costs that much more.
That is why, when the cache seems cold as the pane opens, the model is not asked on its own but waits for the button.
No `effort` is passed; the prompt only asks for a quick answer.
Passing an `effort` other than the session's makes some models write the whole conversation to the cache again.

## Band

When a step is in progress, the band shows `In progress`, its place in the plan (`(3/6)`), the step's name and the time the step began.
Otherwise it shows the newest event, in this form.

| Mark | Kind | Text |
| --- | --- | --- |
| ● (green) | Step completed | `Done <step>` |
| ● (blue) | Step started | `In progress <step>` |
| ○ (gray) | Step set back to pending | `Pending <step>` |
| ● (blue) | Plan created or updated | `Plan created: N steps`, `Plan updated: N steps` |
| ○ (orange) | Recap (`wrap_up`) | `Recap <text>`, with ` / Question: <question>` if it asks one |
| ● (orange) | Question (`AskUserQuestion`) | `Question <first question>`, with ` (+N more)` if there are several |
| ○ (purple) | A person's prompt | `Prompt <text>` |
| ○ (blue) | PR bound | `Linked PR #12` |

The `Status board` button at the end of the line and the `/board` command open and close the pane.
Nothing is shown while there are no events yet.
In the terminal, the step's name or the text is cut to fit the width (keeping `In progress (3/6)`), and if it still does not fit, the line is not shown at all.
It is drawn on a line of its own, apart from the lines of other mods.

## History

Pressing `Show history` lists cards under the board, each holding one prompt a person gave and what happened up to the next one.
In the desktop app a row in the pane cannot jump to its place in the conversation, so the cards are made to be read in full within the pane.

```text
○ 23:20 Fix the band's display
○ 23:38 Fixed the band's colors and dimmed the time. Tests pass.
Question: Shall I fix the README too?
● In progress (3/6) Draw the band
Plan: 6 steps · 2 done · PR #12
```

A card holds, from the top:

- **Heading**: the prompt's time and text. The text wraps to 3 lines at most
- **Recaps and questions**: in the order they happened. A recap is shown in full, wrapped, and if it carries a question, `Question: <question>` follows below it in the warning color. An `AskUserQuestion` takes the form `Question <first question>`, also wrapped
- **In-progress line**: if a step of the plan is in progress, only the newest card shows the same `In progress (k/N) <step>` as the band
- **Footer**: one line folding up the card's plans and steps. The step count of the last plan shown, the number of steps completed, and the PRs bound, joined with ` · `

The recap of a turn started by a task notification or another session's input goes on the card of the prompt before it.
Events before the first prompt are gathered on a card headed `Before the first prompt`.

The cards are listed newest first, five at the start.
`Show N more` shows them all, and `Show only the newest 5` goes back.
The desktop app frames each card with a border; the terminal separates them with a blank line.
In the small form of the pane minimized in the desktop app, it shows not the board but the newest card's latest recap (or, with none, its prompt), up to 3 lines.

Colors follow the theme's colors.
Times are shown as `HH:MM` for today's events and `M/D HH:MM` for earlier ones, in the machine's time zone (the zone `TZ` names, when it holds an IANA name such as `Asia/Tokyo`).
Recaps and questions are cut at 1,000 characters and other texts at 200, and the newest 300 events are remembered.

Counted as a person's prompt is only input that began a turn and was recorded as typed by a person.
Input slipped in by a plugin, a task notification or another session (with `promptSource` of `system`) is not counted.
The `<system-reminder>` parts Claude Code adds to an input are taken out of the text, and input left with nothing else is not counted.

## What shows in which session

The status board sums up the conversation itself, so it can be made in any session.
The events shown in the history and the band depend on the app running the session.
`mcp__ccd_turn__update_plan` and `mcp__ccd_turn__wrap_up`, the sources of plans, steps and recaps, are tools only desktop app sessions have.

- **Desktop app sessions**: all six kinds show
- **Terminal sessions**: only prompts, questions and PR binds show. Cards carry only the heading, questions and the footer's PRs
- **`claude -p` runs**: input is not recorded as a person's prompt, so no prompts show either

How a person's input is recorded was checked against the transcripts of the last 14 days.
In the desktop app `promptSource` is `sdk`, in the terminal `typed` or `queued`, and in both `origin.kind` is `human`.
A `claude -p` input has `promptSource` `sdk` but no `origin`, so it is not counted as a prompt.

## How it works

The events are built not by collecting them in hooks but by reading the session's transcript (JSONL).
The plan's steps decided it.
A step's state can be known only by applying the `update_plan` inputs (replacing the list, `advance`, `done`, `start`) in order to the plan before them.
Collected by hooks alone, the plan so far could not be rebuilt in a conversation brought back with `/resume`, or in a session where the mod was enabled midway.
Past events' times, and whether an input came from a person, are also written only in the transcript.

The transcript is read only from where the last read stopped.
It is read again shortly after a turn starts, when a turn completes, every 2 seconds while a turn runs, and every 30 seconds while idle.
No read holds up a turn.
When `/resume`, `/clear` or `/branch` switches the conversation, the new conversation's transcript is read from the start.
After three failed reads in a row, the status line shows `status-board: cannot read the transcript: <error>`, cleared at the next read that succeeds.
While the transcript does not exist yet (until the session's first input), that is not counted as a failure.

How the events are built is ported from the transcript reading of agent-dashboard, a local dashboard.

## Display language

status-board's text is in English by default.
It switches to Japanese when Claude Code's `language` setting says Japanese (`ja`, `jp`, `jpn`, `japanese`, `日本語`, or a value starting with `ja-` or `ja_`), or, with no `language` setting, when the first of `LC_ALL`, `LC_MESSAGES` and `LANG` that is set starts with `ja` (such as `ja_JP.UTF-8`).
Any other `language` value means English, whatever the environment says.

```json
{ "language": "japanese" }
```

The language covers both what is drawn (the band, the pane, its buttons and labels, the `/board` command, toasts, the status line) and what is sent to the model (the summary prompt).
So the board too is written in that language: the headings and the bullets alike.
A board saved earlier is shown as it was written until it is next updated.
The language is decided when the session starts, so a changed setting takes effect from the next session start or plugin reload.
In both languages, times are shown in the machine's time zone (the zone `TZ` names, when it holds an IANA name such as `Asia/Tokyo`).

## Usage

What has been checked, and what has not yet:

- **Checked in the desktop app (engine 2.1.326)**: the band's display. The pane appearing in a column at the window's right edge. One summary from a button press (5.9 seconds, 321,578 tokens read from the cache, 490 tokens of output)
- **Checked with `claude -p --plugin-dir` (v2.1.327)**: loading the mod (including the hooks being accepted and `/board` registered). Reading the transcript (a 33 MB transcript read to its end, with the count matching one made another way). A summary asked for from the `turn.complete` hook coming back
- **Not yet checked in the desktop app**: the automatic update at the end of a turn. The summary when the pane is opened. Restoring a saved board

How to install and update through `/plugin` is in the [repository README](../../README.md).
To try it without installing, start Claude Code like this from the root of the cloned repository.

```bash
claude --plugin-dir ./plugins/status-board
```

## Limitations

- Nothing is shown in a session without a transcript (`transcriptPath` of `$.session.info()` empty)
- Lines of the transcript longer than 64 MiB (such as an input with a large image pasted) are skipped. Even if such a line is a person's prompt, it makes no card
- The first read is from the start of the transcript, so in a long session it takes a little while for the cards to fill in

## Tests

```bash
cd plugins/status-board
claude plugin test
```

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

The board is Markdown with these five headings.

```text
## Goal
- Show the session's flow in the band and the pane
## Open / waiting on you
- Should the README be rewritten in this pull request, or in a later one?
## Where things stand
- The band's colors are fixed (confirmed by running the tests)
- The pane is being reworked to show one card per prompt
## Decided
- Build the board from the transcript, so it can be rebuilt when the mod is enabled mid-session
## Next step
- The model fixes the tests, then the README
```

The model is asked to write for someone who has not read the conversation, so that they can tell where things stand and what they need to decide without going back to it; being short is not the aim.
A name coined in the conversation (an option's name, a nickname) or a PR or issue number is never written alone: what the thing does comes first, with the name or number in parentheses.
Each item says one thing in 1 or 2 sentences, with no limit on its length.
The whole board is kept to about 2,000 characters (about 1,200 in Japanese), and when it runs over, the model drops items rather than trimming what an item says, keeping the items waiting on the person to the last.

A pull request number on the board, such as `(#12)`, opens that pull request on a click when this session linked it (the PRs the history lists).
The links are added by the mod as the board is drawn, from the URLs the session's transcript holds; the model is not asked to write URLs, since it could make one up.
So the board saved for the session stays as the model wrote it, while `Copy the board` copies it with the links in it.
A number is left as text when:

- the session linked no pull request of that number
- it linked two of that number, from two repositories
- the URL is not `https:`
- it is inside code (backquotes or a fenced block) or an existing link
- it is part of a URL or a word (`issues/12#3`, `abc#12`; `#123` is a number of its own, not `#12`)

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

### Copying

The desktop app does not let you select the pane's text, and a mod has no way to change that.
So the buttons beside `Update the status board` put the text on the clipboard instead: `Copy the board` copies the board shown, in Markdown, and `Copy the history` copies every card as plain text, newest first, whether shown or not.
The history's prompts and recaps are copied as kept, so text past the length the pane keeps (1,000 characters for a recap, 200 for the rest) is already cut.
A toast says whether the copy took.

### Proofreading

The board's wording can carry the vocabulary and turns of phrase typical of AI writing.
How to fix that differs from person to person (a proofreading skill, rules of your own), so the mod does not pick one way: it can apply rules you name to the finished board, as a second pass.
It is off by default; without it, nothing below happens and nothing costs more.

Two settings turn it on.

| Setting | What it is | Default |
| --- | --- | --- |
| `proofreadRules` | The path of the rules file: a skill's `SKILL.md`, or a Markdown file of your own. A leading `~/` is your home folder; a folder means the `SKILL.md` in it | empty (no proofreading) |
| `proofreadModel` | The model that proofreads: an alias (`haiku`, `sonnet`, `opus`) or a full model id | `sonnet` |

A skill that comes from a plugin has the plugin's version in its path, which changes with every update.
For that, a whole segment of the path may be `*`: the mod lists that folder and takes the entry with the highest version (`3.10.0` above `3.9.0`).

```text
~/notes/writing-rules.md
~/.claude/plugins/cache/<marketplace>/<plugin>/*/skills/<skill>
```

Set them where Claude Code keeps a plugin's options: on the screen that sets them when the plugin is installed, as rows of `/config` in the terminal, or in settings.json under `pluginConfigs`, keyed by the plugin. The example below is the form for a plugin loaded with `--plugin-dir`, keyed `status-board`; the key's spelling for an installed plugin has not been checked yet.

```json
{ "pluginConfigs": { "status-board": { "options": { "proofreadRules": "~/notes/writing-rules.md", "proofreadModel": "sonnet" } } } }
```

What happens:

- The summary is shown as soon as it is in, and the button reads `Proofreading…` while the second pass runs. Once the proofread board is in, it takes the summary's place
- The second pass is one call that reads no conversation (`$.model.complete`). It gets a fixed frame from the mod, the rules file's text and the board. The frame tells the model to keep the headings, the number and order of items, facts, numbers, names, what is in parentheses and code in backquotes, to change only wording, and to return only the proofread Markdown. The frame and the rules are sent first and cached
- The reply is checked mechanically: the five headings must come in the same order as in the summary, and the bullets must be as many. A reply that fails is thrown away
- A proofread board adds ` · proofread` to the line under it, and the tokens shown are both passes summed. `Show before proofreading` switches to the board as summarized (and `Show proofread` back); `Copy the board` copies the one shown, and its toast says which (`Copied the proofread board.` or `Copied the board before proofreading.`), since the two can differ by no more than a few commas
- When the rules file cannot be read, is over 200 KB, or the model does not answer, or the reply fails the check, the board stays as summarized and `Could not proofread: <reason>` appears under the button. This is apart from a failure of the summary itself
- The board is saved with both texts once the proofread is done

Limits:

- The rules file is passed as text to follow; the skill is not run. Steps in it that use tools, or point to other files, do nothing
- The rules ride every update of the board, so long rules add time and tokens each time (the cached part costs less within 5 minutes)
- What keeps the meaning unchanged is the frame's instructions and the check of headings and item count. Wording inside an item that drifts in meaning cannot be caught mechanically; compare with `Show before proofreading` when in doubt

### Rough cost

The summary reads the main conversation's cache, so it is cheap while the cache is warm.
One run measured in the desktop app took 5.9 seconds, with 321,578 tokens read from the cache, 1,063 tokens of new input (685 of them written to the cache) and 490 tokens of output.
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

- **Desktop app sessions**: every event in the band's table shows
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
- **Copying in the desktop app (2.1.326)**: a probe plugin's Button calling `$.ui.copy` answered `isCopied: true`. The copy buttons of this mod have not been pressed there yet
- **Checked with `claude -p --plugin-dir` (v2.1.327)**: loading the mod (including the hooks being accepted and `/board` registered). Reading the transcript (a 33 MB transcript read to its end, with the count matching one made another way). A summary asked for from the `turn.complete` hook coming back
- **Pull request links in the desktop app (2.1.326)**: a probe plugin's pane `Markdown` drew a link written `[#55](https://github.com/owner/repo/pull/55)` that opened in the browser on a click. A board of this mod then showed `#56` as a link, which opened that pull request on a click. The terminal (where the types say an OSC 8 link is drawn) has not been tried
- **Not yet checked in the desktop app**: the automatic update at the end of a turn. The summary when the pane is opened. Restoring a saved board
- **Proofreading in the desktop app (2.1.326)**: with `sonnet` and a skill's `SKILL.md` of 41 KB as the rules, found through a `*` segment, the proofread board came back and passed the check of headings and items. It changed 4 or 5 commas and sentence endings a board, and the two calls together wrote 3,672 and 3,887 tokens of output on two boards. `Copy the board` was pressed with each of the two texts shown, and each time copied the one shown. Whether the rules are read from the cache has not been measured

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

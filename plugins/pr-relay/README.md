# pr-relay

English | [日本語](README.ja.md)

A Claude Code mod that checks the session's PR every minute and wakes the session only when it is merged or when Codex reviews it.
The session starts its next piece of work without a person watching GitHub and typing "merged" or "the review is in".
Nor does the model need to call sleep or a polling tool to wait for a review to arrive.
When Codex has left the latest push unreviewed, the mod asks for a review by commenting `@codex review` on the PR.

## The PR it watches

In the desktop app, it watches the PR shown first in the session's PR bar (the PR bound last).
When a new PR is bound, the next check switches the watch to it.
When the first PR is reopened, it starts watching that PR too.
For the other PRs in the PR bar it follows only merges and closes, and tells of them in a toast.
Each merged PR also gets a `cleanup` row.
These checks use the app's cache and add no GitHub requests.

In the terminal, as before, it looks for the current branch's OPEN PR with `gh pr view` when the session starts.
The desktop app falls back on the same lookup when there is no OPEN PR first in the bar, or when the app's information cannot be read.

When `gh pr create` runs in the middle of a session, the mod starts watching from the URL in its output.
When the output holds several PR URLs, it takes the last one not followed by `#` or `/`.
That is because when the same command replies to a review, the URL of the comment replied to (`…/pull/7#discussion_r1`) comes before the new PR's URL.
It also recognizes `gh pr new` and `gh -R owner/repo pr create`, with the repository also given as `-Rowner/repo`, `--repo owner/repo` or `--repo=owner/repo`.
When `git push` runs while no PR is watched, it looks again with `gh pr view`.
With `git -C <dir> push`, it looks for the PR of the branch in the given directory.
Relative paths are taken from the session's working directory; several `-C` are joined in the order given, and resolving `..` is left to the file system.
With `--work-tree=<dir>` or `--work-tree <dir>`, it looks for the PR of that directory, with a relative path taken from the directory after every `-C` has been applied.
An unquoted leading `~` or `~/` is expanded through `HOME`, while a quoted tilde is taken literally, as a relative path.
When the directory contains `$` or a backtick, is an unquoted `~user`, or needs `~` expanded with no `HOME`, the PR lookup for that push is skipped.
When one Bash call holds several `git push` whose lookup directories resolve differently, the push is still tracked and only the PR lookup is skipped.
`git push-deploy`, `gh pr create-extra` and `gh pr new-extra` are not detected.
Passing `pr_url` to `mcp__pr-relay__watch` also starts watching that PR.
While the desktop app's first PR stays the same and OPEN, a watch set in these ways is kept.
When the app leaves out part of its information, the PRs and states already known are kept.

## How it wakes the session

| What happened on GitHub | How the session is told |
| --- | --- |
| Codex left a review | Sends a prompt with the findings' text and where they are |
| Codex finished reviewing the head with no findings (on a PR without a [summary comment](#how-codex-is-read), it gave a 👍 or commented "Didn't find any major issues") | Sends a prompt asking to check CI and report the work complete. The text names the head's SHA at that time |
| Codex has not begun reviewing the head 3 minutes on | Comments `@codex review` on the PR and raises a toast ([conditions](#when-codex-does-not-start-a-review)) |
| Codex hit its usage limit | Raises a toast only |
| The watched PR, or any PR bound in the app, was merged | Raises a toast and puts a `cleanup` button for that PR in the band above the prompt. Pressing it sends a prompt asking for the post-merge follow-up (filing what is left as issues, cleaning up the worktree and branch, steps particular to the project, and so on) |
| The watched PR, or a PR bound in the app, was closed | Raises a toast only |

On a PR with Auto-fix (the CI monitor) on in the desktop app, Codex's reviews, approval by comment and usage limit notices are left to the CI monitor, which also delivers the comment text.
pr-relay then still tells of Codex's 👍 and of merges, and the status line shows `with CI monitor`.
For the first PR it learns that Auto-fix is on from the app's state; for other PRs, from the CI monitor's own notices that reach the session.
If the CI monitor is running in any other session watching the same PR (a desktop app session and a terminal session, say), the review is left to the CI monitor and not sent, even when the session chosen to notify has no CI monitor (so that two sessions do not set off on the same review).
When the app reports that no PR is bound, this judgment is reset.
When the app returns the list of bound PRs, the judgment is also cleared for PRs that have dropped out of that list and the first PR.
When the list is left out, the judgment so far is kept.

What `cleanup` asks for is not only removing the worktree but the whole post-merge follow-up.
The follow-up deletes worktrees and branches, so it does not start on its own but waits behind a button.
If the skill or command used for the work defines its own follow-up (such as `/dev cleanup`), the prompt says to follow it.
Otherwise, it says to proceed in this order.

1. From the PR's URL, confirm that it is merged and find its branch
2. If the project's CLAUDE.md defines post-merge steps, read them before removing anything, and follow their steps and order
3. If items were moved to another PR or left out of scope, ask the user whether to file them as issues
4. Find the worktree that has that branch checked out, and clean up the worktree and the local branch. If the remote branch remains, ask the user whether to delete it
5. Report what was done and what was skipped

Including when following a skill's steps, it says to remove nothing and report when no worktree is found or the PR belongs to another repository.
It says to check for uncommitted changes and unpushed commits before removing anything, and if any remain, to remove nothing and report.
The newest `cleanup` rows are shown, up to three, and `cleanup` and `Dismiss` act on their own row only.
On the desktop, each row is framed with rounded corners and shown as a card apart from the usage meters.
Rows of other PRs stay when the watch changes, and watching the same PR again removes its row.
A PR the app reports OPEN loses its row as well.
The app's other PRs are told of only when one that was OPEN in this session is merged or closed.
When `/resume`, `/clear` or `/branch` changes the conversation, the app's PR states and the `cleanup` rows are reset.
Once a merge or close is seen, polling of that PR stops.

## Rebasing when the base branch moves on

When the watched PR's branch is pushed, the mod checks whether the commits include the tip of the base branch.
If they do not, it appends the following sentence to the Bash result. Only the model reads it.

```
pr-relay: PR #12's base branch main has advanced, and the commits just pushed do not include its tip (1a2b3c4). Rebase onto origin/main before the next push.
```

The base branch's tip is the value taken from GitHub by the poll every minute.
A tip not fetched locally yet also counts as not included.
The check is only a local `git merge-base --is-ancestor`, so it makes no network request at each push.
The rebase is asked for before the next push rather than at once because rebasing in the middle of the work mixes resolving conflicts with the change being implemented.

These pushes are not checked.

- A push that failed, and a push that moved nothing
- A push whose output shows only branches other than the PR's moving
- Pushes made from different directories in one Bash call
- A push from a directory whose origin is not the watched PR's GitHub repository (such as when `mcp__pr-relay__watch` was given another repository's URL). That repository does not have the base branch's tip, so it would wrongly be judged "not included" every time
- A push before the first poll answers (such as right after `gh pr create`). The base branch's tip is not known yet

Up to version 0.9, when the watched PR was seen merged, the mod posted "main has advanced" to notice-board.
But the notices piled up without going away, and reached even worktrees already made from the latest main.
A rebase is needed only just before a push, and only on a branch that has fallen behind, so the check moved to the push.

Prompts are sent with `$.prompt.submit`, so they do not cut into a running turn but start a new turn once the session is idle.

The status line shows the watched PR's number and the time it was last checked, in the machine's time zone (the zone `TZ` names, when it holds an IANA name such as `Asia/Tokyo`).
When `gh pr view` fails at startup and the PR cannot be looked up (not logged in, network down), it shows `PR lookup failed 21:00: <gh error>` and looks again every minute.
A session opened in a folder that is not a git repository, in a repository with no remote, or on a detached HEAD has no PR to find in the first place, so this is treated as "no PR", not a failure.
Nothing is shown in the status line, and it does not look again until `git push` runs.
A URL that `gh pr create` printed is watched at once, without waiting for the next lookup.

## How Codex is read

Codex's 👍 is one per PR and does not say which commit it is for.
When commits Codex has not reviewed are stacked on a PR that still carries the 👍 from an earlier push, GitHub's page shows it as approved.
A look at 170 PRs across 5 repositories in November 2026 found 7 merged with a head Codex had not reviewed.

Codex, on the other hand, keeps one summary comment per PR and rewrites it at every review.
That comment holds the SHA of the commit reviewed, the state (`running` or `completed`), and whether there are findings.
On a PR with a summary comment, the mod decides the head's state from that comment alone.

| What the summary comment says | How the mod takes it |
| --- | --- |
| Reviewed the head with no findings | Tells of it as approved |
| Reviewed the head, with findings | Not approved (the findings are told as a review) |
| A review is in progress | Waits |
| None of the above (stopped at a review of another commit, the head's review not completed) | Treated as unreviewed |

Only the first row is approved; in the other rows a 👍 does not make it approved.
On a PR where the security review's result also appears, that too must finish on the head with no findings before it is approved.
The time of the approval is the time the summary comment was last edited.

The summary comment's format is not a published specification but what was observed on PRs in November 2026.
On a PR without a summary comment, and on one whose format changed so it can no longer be read, approval is judged as before by the 👍 and the "Didn't find any major issues" comment.
In that case the 👍 can keep the creation time of an earlier push, so "there is a 👍" alone is not taken as approved: only one after the last push counts.
Reviews and usage limit comments, with or without a summary comment, count only after the last push.

The time of the last push is the newest of these.

- The time given in `since` to `mcp__pr-relay__watch`, or the time `gh pr create` started
- The time a `git push` started in this session (used only once the push has finished and the PR's head has become a commit in that push's output. If the output names no commit, used once the head has changed from the one known when the push started. `Everything up-to-date` and pushes to another branch do not move the baseline)
- The commit time of the PR's latest commit

Reviews not told yet are told before an approval.
When an approval event comes after the newest review, its time is added at the end of the review prompt, and no separate approval prompt is sent.
An approval at or before the newest review is also recorded as told, and only the review is told.

Only when telling of a review does the mod fetch that review's details in one extra query, putting the findings' text and location, comment ids and URLs in the prompt.
Each body is cut at 4,000 characters, and the whole prompt is kept within 30,000.
Up to 100 inline comments are fetched per review, and the comments that do not fit are pointed to with the count left and the PR's files page.
For a review without inline comments, the review body is included with its `<details>` parts removed.
Even when the details cannot be fetched, the session is woken with the counts and the steps to read the comments with `gh api`.

The mod records whether something has been told, but does not judge whether the findings have been dealt with.
Nor, on a PR without a summary comment, does it judge whether the current head has been reviewed.
The usage limit toast is raised whenever there is a limit comment after the last push, even after the limit has lifted.

### When Codex does not start a review

Codex does not always review the head again at every push.
When it starts by itself, the summary comment turns `running` some 20 seconds after the commit (checked over 6 pushes).
So if the head is still unreviewed 3 minutes after it was first seen, the mod comments `@codex review` on the PR.
Once posted, it raises a toast, and the answer of `mcp__pr-relay__watch` also names the head it was posted for.

It comments only when all of these hold.

- There is a summary comment, and the head falls under "unreviewed" in the table above
- The PR is not a draft, and was created by `gh`'s own user
- There has been no Codex usage limit comment since the last push
- No one other than Codex has commented `@codex review` for the current head since the last push
- It has not commented on that head yet

In the fourth condition, requests for an earlier head do not count.
Those are the comments seen alongside the earlier head when it was checked.
When a head with an older commit date is pushed from elsewhere, the time of "the last push" does not move on, and the comment the mod posted for the earlier head still shows.
Counting it would stop the mod from posting for the next head.
A comment after the head changed does count, even one made before the mod has seen that head.

When the head changes right after the mod posts, before its comment has ever been checked, the mod's comment cannot be told apart from a request for the new head by time.
Only then are comments counted from after the time the new head was first seen.
If a push after the post has moved "the last push" on, the mod's comment drops out of what is read, so this is not done.

The head posted for is kept in the PR's record, so other sessions watching the same PR do not post again.
It is once per head, so if Codex still does not review, nothing more is posted until the next push.
If `gh pr comment` fails, or a push starts just before the post, the record is rolled back and the next check tries again.
On a failure, the status line shows `PR #12 check failed 21:03: @codex review: <gh error>`.

For the watched PR, the events told are recorded per PR in `$.store`.
Another session watching the same PR, or a restarted session, is not woken again for the same event.
When several sessions check the same PR at the same time, only the session that started checking first is woken ("Limitations" below).
When a prompt does not enter the session (a failed send, or a refusal by another plugin), the record is rolled back and the next check sends it again.

## Using it with the /dev skill

The mod registers the tool `mcp__pr-relay__watch`, so if the model's tool list has it, the mod is running.
The `/dev` skill can pass `pr_url` and `since` to this tool to tell the mod the PR and the time of the last push.
Called with no arguments, it returns the watched PR.
The tool's description tells the model not to poll by itself while the mod is watching, but to end its turn and wait to be woken.
It also says that the mod posts `@codex review` after a push, so the model should not post it.
The mod works in sessions without the skill too, and tells in its prompts the steps needed to deal with a review or complete the work.

## Display language

pr-relay's text is in English by default.
It switches to Japanese when Claude Code's `language` setting says Japanese (`ja`, `jp`, `jpn`, `japanese`, `日本語`, or a value starting with `ja-` or `ja_`), or, with no `language` setting, when the first of `LC_ALL`, `LC_MESSAGES` and `LANG` that is set starts with `ja` (such as `ja_JP.UTF-8`).
Any other `language` value means English, whatever the environment says.

```json
{ "language": "japanese" }
```

The language covers both what is drawn (the band's rows and buttons, toasts, the status line) and what is sent to the model (the review, approval and cleanup prompts, and the rebase note).
It is decided when the session starts, so a changed setting takes effect from the next session start or plugin reload.
In both languages, times are shown in the machine's time zone (the zone `TZ` names, when it holds an IANA name such as `Asia/Tokyo`).
What is recorded in `$.store` does not depend on the language, so sessions in different languages share their records.

## Usage

`gh` must be on the PATH and logged in.

### Install

At the Claude Code prompt, run these three in order.

```text
/plugin marketplace add HolyGrail/claude-mods
/plugin install pr-relay@claude-mods
/reload-plugins
```

How to update, and what to keep in mind, is in the [repository README](../../README.md).

### Try it without installing

From the root of the cloned repository, start Claude Code like this.

```bash
claude --plugin-dir ./plugins/pr-relay
```

To always load the local code, add this directory's absolute path to `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`.

## Limitations

The regular requests to GitHub are one GraphQL query a minute.
Reviews, comments and 👍 are each fetched newest first, up to 100, and if the 100th is still after the last push, up to 10 earlier pages are followed.
Telling of a review adds one query to fetch the findings' text.
A simple query costs 1 point, so even 12 sessions running at once use 720 points an hour, within the limit of 5,000 points an hour.

For a PR where no baseline was given when the watch started and no session has seen a `git push` run, the commit time of the latest commit is taken as the time of the last push.
Codex events made between the commit and the push may then be taken as new.

`$.store` has no atomic update, so each session watching the same PR writes its start time to its own key (`poll:<session ID>:<process ID>:<PR>`) every time it starts a check.
When the same conversation is open in two Claude Code processes, the keys are still separate per process, so a notification reaches only one of them (the process ID is kept in the environment variable `PR_RELAY_INSTANCE`).
If a session started checking the same PR first within 30 seconds, or started earlier and is still waiting on GitHub's answer (up to 10 minutes), new events are left to that session to tell, and the PR's record is not written either (so that it is not overwritten with content older than the moment it was read).
The push times a session knows of (including the baseline given when the watch started, and its own `git push` whose head GitHub does not show yet) go into its own key from the start of each check, and the session that notifies reads them and adds them to the baseline.
Within one session, the next check does not start while the previous one is waiting on GitHub's answer.
The premise is that a GitHub request takes far longer than a store write, so a read after the request sees the earlier session's write.
If the session left to notify ends before notifying, a remaining session sends it at the next check (a minute later).
If a session is closed while a prompt sent to it as it worked is still waiting its turn, the told mark is taken back from the PR's record at exit, so a remaining session sends it at the next check.
A take-back of a told mark does not rewrite the PR's record directly but goes under a separate key, `undo:<ID>`. The next session to write the record (the one left to notify) applies it, so a take-back neither erases another session's marks nor is erased by another session's write.
The key of a session whose check failed, or that ended, is out of the running to notify, but the push times it knew of stay.
When writing this key fails at session end, it is written again up to 3 times within a few seconds (a key left mid-check would make other sessions wait up to 10 minutes to notify).
Each process writes the time to `alive:<process ID>` every minute, and a process silent for 3 minutes is taken as ended. Other sessions then wait only a few minutes, not 10, on a key a killed session left mid-check or mid-push. The prompt of a session killed while it waited its turn is also sent again by a remaining session.
This key is deleted after an hour, but one holding push times the PR's record has not counted yet is kept for up to 14 days.
Other sessions' keys are also deleted once out of the running to notify for a day, with the push times they knew of counted by the PR's record (with each `/clear` and `/resume` a key under the old session ID is left behind, and every check would read more and more).
A merge or close too is toasted only by the session left to notify; the sessions that left it learn of it from the record at the next check, stop polling and show the `cleanup` button.
A check that could not write its own key is invisible to other sessions, so it does not ask GitHub but shows a failure in the status line.
A check that could not read other sessions' keys also notifies nothing and shows a failure.
While any session is running `git push` (up to 10 minutes from its start), GitHub may still show the head about to be replaced, so no session notifies.
Which session is woken depends on the order of the checks; a `/dev` session is not preferred.

`@codex review` is posted after the head has been written to the PR's record.
If the process is killed right after the record is written, the record stays without the post, and nothing is posted for that head.
When a session of version 0.10 writes the PR's record, the record of the head posted for is lost.
Even then, nothing is posted if there is an `@codex review` comment after the last push, so posts for the same head do not double.

`gh` failures (not logged in, network down) are shown in the status line and retried at the next check.
When fetching a review's details fails, the steps to check the comments are told in the prompt without waiting for a retry.

CI results are not watched.
The desktop app sends the PR's CI results to the session, so watching them in both places would wake the session twice for the same failure.

## Tests

```bash
cd plugins/pr-relay
claude plugin test
```

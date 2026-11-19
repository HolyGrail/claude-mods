# pr-relay: the multi-session races left after #24

English | [日本語](pr-relay-races.ja.md)

Scope: `plugins/pr-relay/hooks/register.js` (as of main `25a8969`), issue [HolyGrail/claude-mods#26](https://github.com/HolyGrail/claude-mods/issues/26), PR [HolyGrail/claude-mods#24](https://github.com/HolyGrail/claude-mods/pull/24)

This report implements no fix. As material for deciding what to fix first, it sets out each race by its conditions, whether it was reproduced, its impact, how to fix it, and its priority.

**Added 2026-11-04:** Following this report, all 11 have been worked on. Where the fixes stand is in "0. Fix status". Sections 1 onward are left as written at the time of the investigation (main `25a8969`). Line numbers and "the current code" refer to that time.

## 0. Fix status

The fixes are split across two PRs.

- [HolyGrail/claude-mods#45](https://github.com/HolyGrail/claude-mods/pull/45): N3, N2, N6, R2. Merged (pr-relay 0.10.1).
- [HolyGrail/claude-mods#47](https://github.com/HolyGrail/claude-mods/pull/47): N1, R1, R4, N5, R3, R5, N4. Not merged as of 2026-11-04 (pr-relay 0.10.2).

Both PRs say "Part of #26", so merging them does not close issue #26 automatically. That is because some races are not fully closed; whether to close it is decided by the "Remaining limit" column below.

| ID | State | PR | Fix | Remaining limit |
|---|---|---|---|---|
| N3 | Fixed | #45 | At the final `session.end`, take back the marks of prompts whose turn has not begun (`undelivered`) | If the process is killed, `session.end` does not run and the marks stay |
| N2 | Fixed | #45 | Make the note key `poll:<sessionId>:<instance>:<pr>`. `instance` lives in the environment variable `PR_RELAY_INSTANCE`, so a worker replacement does not change it | Environment variables pass to child processes. Reopening the same conversation from within that session's Bash gives the same `instance` |
| N6 | Fixed | #45 | Read the notes in parallel. `prune` deletes other sessions' notes that have been idle a day or more and whose push times the record has counted | None |
| R2 | Fixed | #45 | Judge unseen pushes by the time just before GitHub is asked (`askedAt`) | A push that finishes during the query delays the relay by one round (one minute) |
| N1 | Fixed | #47 | Do not write a take-back into the record directly; put it under `undo:<id>`, for the next session that writes the record to apply. Applied ones are listed in `undone` and stay listed for as long as their key is in the store | Applying is one round late |
| R1 | Partly | #47 | At the final `session.end`, retry the idle write at 200 ms, 1 s and 3 s intervals (`retireFinally`) | Remains when all four are refused, and when the process is killed. Whether the host waits up to 4.2 s at exit is unverified |
| R4 | Partly | #47 | Read the notes again until two reads in a row match (`scanNotes`). If they do not settle, that round sends nothing | A note written between the last matching read and the send is not seen |
| N5 | Partly | #47 | Just before a prompt is sent, read the notes once more and make the same checks (`pushedElsewhere`) | The gap of a few store reads between the last read and the `submit` is not seen |
| R3 | Partly | #47 | If the last push note is refused, retry at 1 s, 5 s and 15 s intervals while the push runs | A write that was accepted but answered late is not prevented |
| R5 | Partly | #47 | While the record is being written, write a `beat` into the note every 60 seconds. Other sessions hold back for 10 minutes from the newest `beat`, and the session's own lease also counts from its `beat` (`beatWhile`, `leaseOf`) | Remains when a `beat` is refused or late. `beat` is written only during the record write, so a lease used up by the GitHub query alone is not protected |
| N4 | Fixed | #47 | Put `monitored: true` in the note, and leave the review to the CI monitor if any live note (not idle, within 3 minutes) says so | By design, while the CI monitor runs, the terminal session is sent no reviews |

One limit is common to all of them. Sessions of the 0.10 series do not read `undo:`, `beat` or `monitored`, and drop `undone` when they write the record. Right after an update, while old and new sessions are mixed, the same races can happen through the old sessions.

**On the reproduction tests:** `reports/pr-relay-races.repro.ts` takes the pre-fix "outcome of the race" as its expectations. So on the fixed code it is right for them to fail. Run on the #47 branch (`75dfb25`), 5 of the 7 (R1, R4, N1, N3, N6) failed and 2 passed. The 2 passed for these reasons.

- **`RACE N2`:** the key this test puts in place is in the 0.10 form, so the fixed code ignores it as its own old note and sends the notification. It meets the expectation and passes, but it does not reproduce the race.
- **`RACE R5`:** this test imitates a successor session that took over and marked by writing to the store directly. After the fix, a session of the new version does not take over as long as the `beat` lands. But the successor the test imitates does not look at `beat`, so it is the same as being taken over by a session of the 0.10 series, and the duplicate happens as before. It is an example of the "limit common to all of them" above.

The behavior after the fix is checked by the tests #45 and #47 added to `tests/pr-relay.test.ts`.

Note that #47 added helpers at the top of the test file, so the "first 378 lines" of section 3 no longer fall at the boundary. When running against the new code, cut just before the first `test(` line.

```bash
n=$(grep -n "^test(" /tmp/pr-relay.test.ts.bak | head -1 | cut -d: -f1)
{ head -n $((n-1)) /tmp/pr-relay.test.ts.bak; cat ../../reports/pr-relay-races.repro.ts; } > tests/pr-relay.test.ts
```

**On the root fix (section 6):** there was no rebuild around a lock. The fixes keep the note scheme and narrow the windows, adding rules for take-backs and takeovers. Closing R4, N5 and R5 completely still needs the atomic operations of section 6.

## 1. Conclusion

Besides the 5 listed in the issue, reading the code turned up 6 more races. 7 of them were reproduced in the test harness. The rest are inferences from reading the code.

Issue #26 says "in every case the worst is one stale or late notification, and nothing is lost". That premise does not hold. **In N3 a notification is lost, and in N1 both a loss and a duplicate can happen.** N2, when its conditions are met, duplicates at every event.

| ID | Race | Source | Checked | Worst outcome | Likelihood | Priority |
|---|---|---|---|---|---|---|
| N3 | When the elected session ends before delivering a prompt it queued, only the mark is left | New | Reproduced (the host's behavior is inferred) | **Loss** | Medium (closing a busy session is enough) | **P1** |
| N2 | When the same conversation is open in two processes, the note keys collide and the election fails | New | Reproduced (one side) | A duplicate every time | Medium (when `--resume` is opened in two places) | **P1** |
| N6 | Notes under past session ids keep piling up, and every poll reads them one at a time, three times | New | Reproduced | Every race's window widens | High (each `/clear` adds an id) | P2 |
| R2 | `seenAt` is taken after the GraphQL answer | #26 | Inferred | One stale notification | Low | P2 (cheap to fix) |
| N4 | Whether the CI monitor runs is known only per session, so the outcome depends on which session is elected | New | Inferred | Duplicate (when desktop and terminal are mixed) | Medium | P2 |
| N1 | The read, change and write of a take-back overwrites another session's newer marks | New | Reproduced | Duplicate, or loss | Low | P3 |
| R1 | If the last write at `session.end` fails, the note stays `running` | #26 | Reproduced | Up to 10 minutes' delay | Low | P3 |
| R4 | The last scan of the notes is not a snapshot | #26 | Reproduced | One stale notification | Low | P3 |
| N5 | Other sessions' pushes between the last scan and the actual send are not seen | New | Inferred | One stale notification | Low | P3 |
| R3 | The last push heartbeat is fired without being awaited | #26 | Inferred | Delay, or a stale notification | Very low | P4 |
| R5 | Taking back a record written past the lease also erases the marks a successor session made | #26 | Reproduced | One duplicate | Very low | P4 (can be deferred) |

The recommended order is in "7. Proposed order of fixes".

## 2. Background: how the election works (recap)

- Before polling, each session writes its own note `poll:<sessionId>:<pr>` (`notePoll`, `register.js:916`). It holds `{ at, since, pending, running, ... }`.
- When the GraphQL answer comes, the session reads the other notes (`readNotes`, `register.js:1187`). If a note that started before its own exists within 30 seconds, or one within 10 minutes is still `running`, it holds back (defers).
- Only the elected session (the leader) reads the shared record `pr:<url>`, marks it and writes it back (`register.js:751-779`), and then sends the prompt (`deliver`). If the send fails, it takes the marks back (`takeBack`).
- `$.store` has no atomic update, no conditional write or delete, and no snapshot read. Within a session `exclusive` serializes the writes, but nothing excludes across sessions.
- Lease: work past `RUNNING_MS - ROUND_MS` (9 min 30 s) from the start of the poll sends nothing (`lapsed`, `register.js:839`).

## 3. How to reproduce

The reproduction tests are in `reports/pr-relay-races.repro.ts`. They use the existing tests' `stubWorld` and constants, so they run appended to the end of the test file. Every test takes "the current outcome of the race" as its expectation, so fixing a race turns it red.

Appended straight to the existing test file, one `the file ran to its end` fails at the end of the file. That is a problem of the existing suite: adding a single 3-second test that does nothing gives the same failure (Appendix A). The reliable way is to join the reproduction tests to the helper part (the first 378 lines) and run them alone.

```bash
cd plugins/pr-relay
cp tests/pr-relay.test.ts /tmp/pr-relay.test.ts.bak
{ head -n 378 /tmp/pr-relay.test.ts.bak; cat ../../reports/pr-relay-races.repro.ts; } > tests/pr-relay.test.ts
claude plugin test     # 7 pass (each showing the race happened)
cp /tmp/pr-relay.test.ts.bak tests/pr-relay.test.ts
```

Environment checked: Claude Code 2.1.318. The existing suite alone: 344 pass.

The test harness can run the module of only one process. So "another session" is imitated by writing notes or records to the store in advance, or by writing in the middle of `gets`/`sets` hooks.

## 4. Races listed in issue #26

### R1. If the last write at `session.end` fails, the note stays `running`

- **Checked**: reproduced (`RACE R1`). That other sessions are then kept waiting 10 minutes is checked by the existing test `a poll of another session still running past its round keeps holding back later ones`.
- **Conditions**: the session ends during a poll (waiting on GraphQL) or during a `git push`, and `$.store` refuses the `retire` write (`register.js:1013`). `writeNote` is called non-strict, so the failure is swallowed. Even with `dirty` set, nobody retries in a module that has ended.
  - The same outcome follows when the process is killed. Then not even a failed write is needed.
  - The same outcome also follows when an earlier write is stuck and the host's exit timeout does not wait for the `retire` queued behind it in `noteWrites` (inferred).
- **Impact**: other sessions watching that pull request keep holding back for up to `RUNNING_MS` (10 minutes). If the session ended during a push, `pending[].running` stops everyone's relays for up to 10 minutes. Notifications are late but not lost.
- **Fix**:
  1. At `session.end`, call `retire` strict, and on failure retry a few times at short intervals (for example 200 ms, 500 ms, 1 s).
  2. At the root, shorten how long `running` holds. While polling, beat a heartbeat that overwrites the note's `at` every 60 seconds, and have other sessions "take it as dead after two missed heartbeats". Then `RUNNING_MS` can shrink from 10 minutes to 2 or 3, and the delay after a kill shrinks with it. The lease computation (`lapsed`) changes to count from the heartbeat's time.
- **Priority**: P3. 1 can go in at once. 2 is best designed together with R3.

### R2. `seenAt` is taken after the GraphQL answer

- **Checked**: inferred. The mock clock answers at once, so a reproduction that delays reading the clock could not be built.
- **Conditions**: within `query`, `seenAt = await $.clock.now()` is taken after the `gh` process has exited and its JSON has been parsed (`register.js:1450`). Another session's push that finishes in between (`gh`'s cleanup, event loop delays) gets `doneAt < seenAt`. As a result `unseen` (`register.js:901`) is false, and it is treated as "GitHub showed the head after this push".
- **Impact**: what GitHub actually showed was the head before the push replaced it. So a review or 👍 on the head before the push can be relayed once as "new".
- **Fix**: split the time in two.
  - `askedAt`: taken just before calling `gh`. Used for the `unseen` check (hold back if `doneAt >= askedAt`). It errs early, so it errs on the safe side.
  - `answeredAt`: taken where it is now. Used for `record.headAt` and `lastHeadAt`.
  - Moving only one time earlier breaks the `recordHead` check of `pushCounts` (`register.js:864`) the other way, so the two need to be split.
- **Priority**: P2. A change of a few lines, with little effect on the existing tests.

### R3. The last push heartbeat is fired without being awaited

- **Checked**: inferred.
- **Conditions**: within the Bash `tool.call`, the start of a push is published through four note writes. Only the last `publish()` (`register.js:301`) is not awaited. If the store is slow for the first three and the last is late or refused too, other sessions are left with a stale `push.at`. Other sessions take a push as "still running" by `push.at >= note.at - RUNNING_MS`, so they treat it as "a push that hung and died" sooner than it really is.
- **Impact**: limited to a push that runs close to 10 minutes, or a store stuck for minutes. It is very unlikely to actually happen.
- **Fix**: align with R1's heartbeat scheme. While a push runs, rewrite the note every 60 seconds, and have other sessions judge by the time of the last heartbeat.
- **Priority**: P4. Settle it together with R1's 2.

### R4. The last scan of the notes is not a snapshot

- **Checked**: reproduced (`RACE R4`). During the last `readNotes`, after `store.keys()` has listed the keys, a fourth session writes a note of a running push. The review prompt was still sent.
- **Conditions**: `readNotes` lists the keys (`keys()`) and then `get`s them one at a time (`register.js:1188-1194`). A key created after the listing is not seen. Nor is a key rewritten after it was read.
- **Impact**: a review or 👍 on the head just before a push started in another session arrives once. The window is a few store reads wide (milliseconds). With N6, however, it widens to seconds.
- **Fix**:
  1. Narrow the window. Make the `get`s parallel with `Promise.all`, and after reading take `keys()` again, reading again if the list changed.
  2. Fix N6, reducing the number of keys read in the first place.
  3. Closing it completely needs a lock across sessions (section 6).
- **Priority**: P3. 1 and 2 are cheap.

### R5. Taking back a record written past the lease also erases the marks a successor session made

- **Checked**: reproduced (`RACE R5`). While the record write takes 10.5 minutes, a successor session marks the same review and sends it. Then this session's write lands, the take-back runs, and the marks are emptied. In the next round this session sends the same review too (twice in all).
- **Conditions**: `$.store.set` is stuck for 9 min 30 s or more, and meanwhile another session takes the election over and marks.
- **Impact**: one duplicate. Dropping the take-back instead loses the notification when "the successor sees this session's mark and does not send". #24 chose the duplicate.
- **Fix**: needs a conditional write (CAS) or a lock across sessions (section 6). One mitigation fits within the current API: read the record again just before taking back, and do not take back unless `record.at` is this session's `now`. It does not help in this reproduction's scenario, however, where this session's slow write lands later.
- **Priority**: P4. The conditions are very narrow, so it can stay a known limit.

## 5. Races newly found in the code

### N1. The read, change and write of a take-back overwrites another session's newer marks

- **Checked**: reproduced (`RACE N1`). The steps are these.
  1. The prompt this session sent is dropped, and `takeBack` reads the record.
  2. Before it writes back, another session writes the mark for review 2.
  3. `takeBack`'s write-back erases the mark for review 2.
  4. In the next round, review 2 is sent again.
- **Conditions**: `takeBack` (`register.js:1395`) reads the whole record, applies `undo` and writes it back whole. `exclusive` serializes only within the same session. `deliver` does not resolve until the prompt's turn begins, so `takeBack` may run minutes after the marks were made. By then the leader of the next round (possibly another session) is writing the record. Any of these can set off a take-back.
  - The prompt was dropped
  - This session pushed while fetching the details
  - The conversation was switched
- **Impact**: in the reverse order, a loss happens too. If another session reads the record before the take-back and writes it back after, the take-back is erased. The dropped prompt is then never sent again.
- **Fix**: stop reading, changing and writing the record, and split the marks into a key per event.
  - For example `sent:<pr>:review:<id>`, `sent:<pr>:approved` (the value a time), `sent:<pr>:usage`.
  - The leader writes only the keys of the events it sent. A take-back only deletes that key.
  - Only `since`, `head` and `headAt` stay in the record. Each only ever grows, so the last writer winning does little harm.
  - This way a take-back never touches another session's marks.
- **Priority**: P3. The conditions are narrow, but it is one of the paths to a loss. The record's format changes, so a migration (reading the old `reviews[]`) is needed too.

### N2. When the same conversation is open in two processes, the note keys collide and the election fails

- **Checked**: reproduced (`RACE N2`, one side only). A `running` note started 1 second earlier is put under this session's own key `poll:session-b:<pr>`. This session still sent without holding back. The other process should behave the same way, but the harness can run only one process, so that is inferred from symmetry.
- **Conditions**: the note key is decided by the session id alone (`register.js:918`). `readNotes` excludes the session's own key (`register.js:1188`). So two processes with the same session id do not see each other's notes. What is more, they overwrite the same key in turn. Examples with the same id:
  - The same conversation opened from two terminals with `claude --resume <id>`
  - The same conversation opened in the desktop app and a terminal
  - The old and new workers overlapping during a worker replacement
- **Impact**: both processes become the leader every round, and both are woken at every review, 👍 and merge. The two processes also fight over the store's record, causing the same overwrites as N1. The problem #24 meant to fix, "woken twice for the same review", remains as it was under these conditions.
- **Fix**: put a per-process identifier in the note key.
  - For example, make `instance = pushId(now)` when the module loads, and use `poll:<sessionId>:<instance>:<pr>`.
  - The takeover at a worker replacement (where `notePoll` reads the previous note) changes to look for keys starting with `poll:<sessionId>:`.
  - `prune`'s check for "this session's own notes" keeps working as a session id prefix match.
- **Priority**: P1. The change is local, and when it happens it duplicates every time.

### N3. When the elected session ends before delivering a prompt it queued, only the mark is left

- **Checked**: reproduced (`RACE N3`). When `session.end` (`prompt_input_exit`) was sent before the prompt's turn began, the mark stayed in the record. When another session then watched the same pull request, the review was not sent. How the host treats queued plugin prompts at exit (whether it resolves `$.prompt.submit` as dropped, or leaves it) has not been checked. That part is inferred.
- **Conditions**: the leader marks the record before sending. `deliver`'s `submit` resolves after the turn begins, so while the leader is busy the prompt waits in the queue. If the person closes that session meanwhile, one of these follows.
  - `submit` never resolves
  - Even if it resolves as dropped, the module has stopped, so `takeBack` cannot write
  - The leader is "the session that started polling first", so it is common for a session the person is not looking at, or one about to close, to be elected.
- **Impact**: **loss**. Other sessions see the mark and never send. Nobody is told the review came.
- **Fix**:
  1. Keep the sends in delivery in the module as `inFlight`. At the final `session.end`, before making the note idle, `takeBack` everything whose turn has not begun, and await it before ending. In the next round another session sends it again.
  2. To cover a kill, give the mark `by: <sessionId>` and `deliveredAt`. `deliveredAt` is added when the turn begins and `submit` resolves. Other sessions take "a mark with no `deliveredAt` whose `by` note is idle or old" as unsent and send it again. Put in together with N1's key per event, the design comes out clean.
- **Priority**: P1. It happens in normal use (closing a busy session) and the outcome is a loss, so it is the heaviest.

### N4. Whether the CI monitor runs is known only per session, so the outcome depends on which session is elected

- **Checked**: inferred.
- **Conditions**: `monitored` (`register.js:136`) is decided only by that session's desktop state and `<ci-monitor-event>`, and is not shared through the store. `relay` looks at `monitored.has(pr.id)` to switch between silently marking a review and sending it in a prompt (`register.js:1225`). Take a desktop session A where the CI monitor auto-fixes the pull request, and a terminal session B, both watching it.
  - If B becomes the leader, B sends the review prompt while the CI monitor delivers the review to A. Two sessions set off on the same review (a duplicate).
  - If A becomes the leader, B gets nothing. That may be called as designed.
- **Impact**: which happens changes every time with the order of the polls. The behavior is unpredictable.
- **Fix**: put `monitored: true` in the note, and have the leader "treat the pull request as monitored if any live note for it says so". Whether the specification should be "with a CI monitor, send nothing to the terminal side" needs deciding.
- **Priority**: P2.

### N5. Other sessions' pushes between the last scan and the actual send are not seen

- **Checked**: inferred.
- **Conditions**: this is about the time from the end of `pollNoted`'s last `readNotes` until `deliver` fetches the review details (one `gh api graphql`, taking seconds) and calls `submit`. In that time only this session's own pushes (`pushStarts`, `register.js:1299`) are checked; other sessions' notes are not read again.
- **Impact**: as with R4, one notification about the head just before a push arrives. The window is seconds, so wider than R4's.
- **Fix**: in `deliver`, call `readNotes` once more after fetching the details and just before `submit`. With the same check as `moved`, take back if a new push or `since` is seen.
- **Priority**: P3.

### N6. Notes under past session ids keep piling up, and every poll reads them one at a time, three times

- **Checked**: reproduced (`RACE N6`). 200 idle notes under past session ids are put in place for the same pull request. One poll ran 600 `get`s one after another (3 seconds at 5 ms each). None of the 200 was deleted.
- **Conditions**: `prune` (`register.js:1560`) deletes only notes under this session's current id, and other sessions' notes "older than 14 days, whose pull request has ended or has no record". The session id changes with each `/clear`, `/resume` and `/branch`, so idle notes under old ids keep growing for a pull request that stays open. `readNotes` is called up to three times per poll, each reading one at a time with `for … await`.
- **Impact**: in itself a performance problem, but it widens the windows of R4, N5 and lease consumption (R5, R1). It tells in an environment with a slow store.
- **Fix**:
  1. Make `readNotes`'s `get`s parallel.
  2. Have `prune` delete other sessions' notes that are idle, whose `since` and `pending` the record has counted (`counted`), and that have not been written for 24 hours or more. If the owner rewrites the note while it is being deleted, that note may still drop out of the election for one round. Even so, the chance that the owner of an idle note untouched for 24 hours comes back at exactly that moment is small. The cost is at most one duplicate, which is acceptable.
- **Priority**: P2. Cheap to fix, and it lightens the other races.

## 6. On a root fix

Closing R4, R5 and N1 completely needs atomic operations, as #26 also says.

- **CAS in `$.store`**: the type declarations (`.claude-plugin/types`) are not in the repository, so the API could not be fully checked. The `$.store` calls `claude plugin validate` lists are only `get`, `set`, `keys` and `delete`, and no conditional operation is to be seen. If the host would add one, that would be the most straightforward.
- **A lock through `mkdir`**: `$.process.run(['mkdir', <dir>])` succeeds or fails atomically on a local POSIX file system. It could serve as a lease per pull request and per round. For example, write the creation time into `~/.claude/pr-relay/lock/<pr-hash>`, and take it over when it is old. The note election itself could then be replaced by "the session that takes the lock relays". Most of the complexity around `pending`, `deferred` and `landedAt` would no longer be needed. In exchange, these need checking.
  - Whether it works on Windows
  - How to handle the race when taking a lock over (between deleting the old lock and creating the new)
  - The cost of starting a process at every poll (small, once every 60 seconds)
  - If `$.fs` has an exclusive create, that would be better. This too is unchecked.

The current note scheme is what #24 built over 36 commits, closing edge cases one by one. Whether to keep adding the fixes for N1 to N6 on top of it, or to rebuild around a lock, is worth deciding once.

## 7. Proposed order of fixes

1. **N3** (loss): its 1, "take back the undelivered sends at `session.end`", alone saves most cases.
2. **N2** (a duplicate every time): put a per-process identifier in the note key. A local change.
3. **N6 and R2**: both cheap. N6 narrows the windows of R4, N5 and R1 at once.
4. **N4**: do it together with the decision on the specification (where to send when a CI monitor runs).
5. **N1 and N3's 2**: design splitting the marks into keys per event together with adding `deliveredAt`. The record's format changes, so a migration is needed too.
6. **R1, R3, N5**: do them along with introducing the heartbeat.
7. **R5**: deferred. It goes away when the root fix (section 6) goes in.

Deciding whether to rebuild around section 6's lock before starting on 5 avoids doing the work twice.

**Added 2026-11-04:** in the event the fixes went N3 → N2 → N6, R2 (#45) → N1 → R1 → R4 → N5 → R3 → R5 → N4 (#47).

- **N1 and N3's 2:** 5 proposed designing them together, but only N1 was fixed, in the form of take-back slips (`undo:`), and N3's 2 (`deliveredAt`) was not put in.
- **Heartbeat:** the heartbeat over the whole poll proposed in 6 was not put in. Instead, for R5, a `beat` written only while the record is being written was put in.

## Appendix A: cleaning up after the existing test suite

Adding just one 3-second test that does nothing to the end of `tests/pr-relay.test.ts` makes `the file ran to its end` fail (`$.clock.now refused: no hooks module of that name is loaded`, environment 600 / 612 / 614). One of the existing tests leaves asynchronous work behind after it ends. It does not show today because the file ends at once. It is a separate problem from these races, but it is bound to come up whenever tests are added, so it is worth finding which test causes it.

**Added 2026-11-04:** [HolyGrail/claude-mods#46](https://github.com/HolyGrail/claude-mods/pull/46) fixed it by having the slow writes land within each test.

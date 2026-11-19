# usage-meter

English | [日本語](README.ja.md)

A Claude Code mod that keeps the context usage and the 5-hour and weekly limit usage on view in the band above the prompt.
For an account with per-model weekly limits, such as Fable's, it shows those too.

```text
ctx ██░░░░░░░░ 20%   5h ██████┃░░░ 62% 2h13m (23:13)   7d ┃░░░░░░░░░ 5% 4d18h   Fable ┃░░░░░░░░░ 3%
```

## Display

- **Gauge**: the usage is filled in, with a vertical line over it marking how far the window has run. The desktop app draws it in SVG, the terminal as a bar of characters. In the terminal the bars are dropped when every meter with its bar does not fit on one line. In the desktop app the bars get shorter once there are four or more meters, and where even that does not fit, whole meters wrap to the next row
- **Color**: set by the share of the window elapsed minus the usage. Green when that is +10 or more, red when it is under −15 or the usage is 90% or more, yellow in between
- **Time left**: the time until the reset follows the meter. The 5-hour limit also gives the reset time on a 24-hour clock, in the machine's time zone (the zone `TZ` names, when it holds an IANA name such as `Asia/Tokyo`)
- **Context**: with no time axis, its color comes from the usage alone (with 50% and 80% as the thresholds)
- **Per-model weekly limits**: labeled with the model's name and drawn by the same rules as the weekly limit. The time left is dropped when the reset falls at the same time as the weekly limit's, and shown only when they differ

## Usage

The official documentation says mods need Claude Code v2.1.287 or later.
In practice it has been seen working on v2.1.286, while on v2.1.284 the mod was not loaded.

The desktop app runs on the Claude Code bundled with it.
The band appears in sessions started afresh in an app that bundles Claude Code v2.1.286 or later (2.19675.0 or later).
A session that has been running since before the app was updated sometimes showed no band, even when resumed.
In that case, open a new session.

### Install

At the Claude Code prompt, run these three in order.

```text
/plugin marketplace add HolyGrail/claude-mods
/plugin install usage-meter@claude-mods
/reload-plugins
```

How to update, and what to keep in mind, is in the [repository README](../../README.md).

### Try it without installing

From the root of the cloned repository, start Claude Code like this.

```bash
claude --plugin-dir ./plugins/usage-meter
```

To always load the local code, put this directory's absolute path in `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json`.
## Limitations

The 5-hour and weekly limits are per account, so the readings are shared through `$.store` with every session on the machine.
A session that has not received a reading yet shows the newest one another session saved, and usage in another session shows up within a minute.

`$.store` has no atomic update, so each session writes only its own key and never overwrites another session's reading.
Even so, a delete and a write of a key that overlap within milliseconds can still race.
For example, if a session that has not measured for 8 days or more measures at the very moment another session deletes its key as stale, that reading is not shared.
Even then, every session's display comes right again at the next measurement.

The mods API gives no way to tell accounts apart, so the shared readings do not either.
After switching to another account on the same machine, the previous account's readings show until a new session receives its first response.

### Per-model weekly limits

The per-model weekly limits come from `https://api.anthropic.com/api/oauth/usage`, the same endpoint the `/usage` screen reads.
That is because the mods API passes only the 5-hour and weekly limits, with no per-model values.
It authenticates with the handle from `$.session.authorize()`, so no token ever reaches the mod.

- The endpoint is asked about once every 5 minutes across the whole machine, and the reading is shared with every session through `$.store`. The display can lag by up to 5 minutes
- Sessions on an API key, a third-party provider or a gateway do not ask. An account whose answer has no per-model limit gets no meter for it
- The extra meter widens what the terminal needs to keep the bars. With the values in the example at the top, that is 101 columns; anything narrower drops the bars from every meter
- This is not a public API, so if the shape of its answer changes, the meter stops updating. Such a meter disappears at its reset time

## Tests

```bash
cd plugins/usage-meter
claude plugin test
```

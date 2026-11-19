# cache-meter

English | [日本語](README.ja.md)

A Claude Code mod that keeps a gauge of how many minutes the conversation's prompt cache has left in the band above the prompt.
Once the cache has expired, it shows how many tokens the next message will write to the cache again.

```text
cache ● ~1h ████████░░ 48m left · hit 91% · misses 0
cache ● ~1h █░░░░░░░░░ 53s left · hit 91% · misses 0
cache ○ cold · next message re-caches 128k tokens
```

Claude Code sends the whole conversation again with every message, and the cache is what makes that rereading cheap.
Yet the time the cache has left is out of sight unless you open `/usage` or write a status line script.
When the first turn after you step away and come back is slow and uses a lot, it is because the TTL ran out meanwhile.
If there is something you want to ask while little time is left, asking before the cache expires costs less.

## Display

- **Gauge**: fills the share of the TTL that is left. The desktop app draws it in SVG, the terminal as a bar of characters, and in the terminal the bar is dropped when the line does not fit. It is drawn on a line of its own, apart from the lines of other mods such as usage-meter
- **Color**: green while 20% or more of the TTL is left, yellow below 20%, red once expired
- **Time left**: counts down by the minute, and by the second in the last minute. It turns to `cold` the moment the cache expires
- **hit**: the share of input tokens in this conversation's main requests that were read from the cache
- **misses**: the number of requests that read less than half of what the cache held after the request before. When the cause is known (`expired` for a lapsed TTL, `model switch` for a model switch) it follows in parentheses. The rebuild after `/compact` is not counted

A cache that is not warm is shown like this.

| Display | State |
| --- | --- |
| `cache ○ cold · next message re-caches N tokens` | The TTL has passed. N is the last response's input (cache reads and writes included) plus its output |
| `cache ○ cold · model switch · …` | The model was switched. The cache is per model, so the next request writes the whole conversation again |
| `cache ○ rebuilding · …` | After `/compact`. The conversation's part of the cache is rebuilt from the summary at the next request |
| `cache ○ off · no cache tokens reported` | The response had no cache reads or writes. Caching is off, or a gateway does not report it |
| `cache ○ off · DISABLE_PROMPT_CACHING` | Caching is turned off by the environment variable |

Nothing is shown until the first response comes back, or right after `/clear`.

## How the TTL is decided

The time left counts from when the main conversation's last request was sent.
That is because each request that reads the cache resets its timer.
Subagents and workflows have caches of their own, with TTLs of their own, so their requests do not restart the count.
A fork, however, carries the conversation over as it is, so its first request reads the main conversation's cache and restarts the time left.

The TTL is decided in the same order of precedence Claude Code uses.

1. The TTL Claude Code itself reports at a model switch (`cache_ttl` of `PostModelSwitch`)
2. 5 minutes if `FORCE_PROMPT_CACHING_5M=1`
3. The environment variable `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` or `1h`)
4. The setting `promptCacheTtl` (`5m` or `1h`)
5. 1 hour if `ENABLE_PROMPT_CACHING_1H=1`
6. Otherwise the default: 1 hour on a subscription within the plan's usage, 5 minutes when paying with usage credits past the plan's usage, and with an API key or a cloud provider

Only the default in 6 is an estimate, so the TTL gets a leading `~` (`~1h`).
The mods API does not pass the kind of plan directly, so an OAuth login is taken as a subscription, and a 5-hour or 7-day limit at 100% as usage credits.
1 is the real value, but it arrives only when the model is switched.

The TTL is decided and recorded for each request when its response comes back.
Claude Code too picks a TTL for each request, so a 5-minute cache written on usage credits still expires in 5 minutes after the plan's usage comes back.

## Usage

Loading, and the display from real responses, have been checked on Claude Code v2.1.292.
How to install and update through `/plugin` is in the [repository README](../../README.md).
To try it without installing, start Claude Code like this from the root of the cloned repository.

```bash
claude --plugin-dir ./plugins/cache-meter
```

## Limitations

The mod cannot see the following, so they do not show in the display.

- `/rewind`: later requests keep reading the prefix rewound to, so the cache stays. The re-cache token count, however, still shows the size before the rewind
- Entering and leaving plan mode under `opusplan`: this is a model switch, but when no switch event comes, the previous model's time left shows until the next response comes back
- Changing effort, just after turning on fast mode, connecting an MCP server: the cache is lost in most cases, but the display does not change until the next response
- Per-model disabling such as `DISABLE_PROMPT_CACHING_SONNET`: it applies only to the model the family's alias points to, and the mods API does not say what the alias resolves to. Right after switching to that model the display reads `cold`, and turns to `off` at the first response

An official status line script gets `expires_at` and `recache_tokens_if_cold` from the `prompt_cache` object (v2.1.251 or later), computed by Claude Code itself.
This mod works within the mods API, which cannot reach those values, and builds the same things from the responses' token counts.

## Behavior relied on

All of it is from [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching).

- Each request that reads the cache resets the TTL's timer
- On a subscription within the plan's usage, the main conversation gets 1 hour and subagents and workflows 5 minutes. With usage credits, an API key or a cloud provider the main conversation also gets 5 minutes
- The cache is per model, and under `opusplan` entering and leaving plan mode is a model switch
- `/compact` rebuilds the conversation's part of the cache, and `/rewind` reads the cache of the point rewound to as it is

## Tests

```bash
cd plugins/cache-meter
claude plugin test
```

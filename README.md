# claude-mods

English | [日本語](README.ja.md)

A collection of Claude Code mods.
The repository is itself a plugin marketplace, so the mods install straight from Claude Code.

## Mods

| mod | What it does |
| --- | --- |
| [usage-meter](plugins/usage-meter/README.md) | Keeps the usage of the context, the 5-hour limit, the weekly limit and per-model weekly limits (such as Fable's) on view above the prompt |
| [cache-meter](plugins/cache-meter/README.md) | Keeps on view above the prompt a gauge of how many minutes the conversation's prompt cache has left, and, once it has expired, how many tokens the next request will write to the cache again |
| [notice-board](plugins/notice-board/README.md) | Posts notices to every session of the same repository, delivered to each session's band and model |
| [pr-relay](plugins/pr-relay/README.md) | Watches the session's PR and wakes the session only when it is merged or Codex reviews it |
| [status-board](plugins/status-board/README.md) | Shows a summary of the whole session written by the model (the status board) and a history by prompt in a pane beside the conversation, and where things stand above the prompt |
| [zsh-safe](plugins/zsh-safe/README.md) | Lets Bash commands written the bash way run as they are under macOS's zsh |

The mods' text is in English by default.
pr-relay and status-board switch to Japanese when Claude Code's `language` setting, or the `LC_ALL` / `LC_MESSAGES` / `LANG` environment variables, say Japanese ([pr-relay](plugins/pr-relay/README.md#display-language), [status-board](plugins/status-board/README.md#display-language)).
The other four mods have English text only.
Times the mods show are in the machine's time zone (the zone `TZ` names, when it holds an IANA name such as `Asia/Tokyo`).

## Install

At the Claude Code prompt, run these three in order.

```text
/plugin marketplace add HolyGrail/claude-mods
/plugin install usage-meter@claude-mods
/reload-plugins
```

`/reload-plugins` starts the mod.
If it does not show up, restart Claude Code.
The Claude Code version each mod needs is in that mod's README.

From a terminal, these commands do the same.

```bash
claude plugin marketplace add HolyGrail/claude-mods
```

```bash
claude plugin install usage-meter@claude-mods
```

On Team and Enterprise plans, an administrator may restrict which marketplaces can be added.
In that case, ask the administrator to allow this repository.

## Update

Pull in the marketplace's information, then update the mod.
The update takes effect after Claude Code restarts.

```bash
claude plugin marketplace update claude-mods
```

```bash
claude plugin update usage-meter@claude-mods
```

## Caution

Mods run on your machine with the same permissions as Claude Code, with no sandbox.
Read through the code under `plugins/` before installing.

## Development

Each mod lives in `plugins/<name>/` and is registered in `.claude-plugin/marketplace.json` at the root.
To try local changes, load the directory directly without installing.

```bash
claude --plugin-dir ./plugins/usage-meter
```

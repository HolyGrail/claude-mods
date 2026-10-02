# Repository Guidelines

## Project Structure & Module Organization

Claude Code plugins live under `plugins/<name>/`: `usage-meter`, `notice-board`, `pr-relay`, and `zsh-safe`. Each plugin contains:

- `.claude-plugin/plugin.json` for metadata.
- `hooks/hooks.json` for module registration and `hooks/register.js` exporting `register(on)`.
- `tests/<name>.test.ts`, `tsconfig.json`, and a Japanese `README.md`.

`plugins/zsh-safe/zdotdir/.zshenv` supplies shell configuration; usage-meter generates SVG inline. Register new plugins in root `.claude-plugin/marketplace.json` and bump the affected plugin's manifest version for user-visible changes. Consult `CLAUDE.md` for architecture details and keep guidance consistent.

## Build, Test, and Development Commands

There is no `package.json` or build step: Claude Code runs hook modules as plain JavaScript. From the affected plugin's directory, run:

```bash
claude plugin test            # Run *.test.ts and *.test.tsx tests
claude plugin validate .      # Validate the manifest and inspect hook/API usage
npx -y -p typescript tsc -p .  # Type-check tests
```

Type checking requires the untracked `.claude-plugin/types/` declarations referenced by `tsconfig.json`. It does not check `hooks/register.js`; validate that module with `claude plugin validate`.

For a live session, run `claude --plugin-dir ./plugins/usage-meter` from the repository root.

## Coding Style & Naming Conventions

Match existing JavaScript and TypeScript: two-space indentation, single quotes, no semicolons, and trailing commas in multiline structures. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and kebab-case plugin directories. Keep runtime hooks in JavaScript. No formatter or linter is configured.

Write user-facing READMEs in Japanese; use English for comments, test descriptions, and commit messages.

## Testing Guidelines

Use `test`, `expect`, and `mock` from `claude-code/testing`. Name files `*.test.ts` or `*.test.tsx`, with descriptions stating observable behavior. Use `mock.clock` for deterministic timing and reuse plugin-specific helpers, such as usage-meter's `stubSession`/`stubStore`, for shared-state scenarios.

Add regression coverage for changed behavior, especially session restarts, store synchronization, and terminal/Desktop rendering. No numerical coverage threshold is configured. Run the relevant plugin checks before submitting code changes.

## Commit & Pull Request Guidelines

Follow history with short English imperative subjects, such as `Share readings through a key per session`. Use commit bodies to explain non-obvious behavior or tradeoffs.

PRs should describe the problem, resulting behavior, and validation performed. Link relevant issues when available; include screenshots or terminal examples for visible changes. Update the plugin README when behavior or limitations change.

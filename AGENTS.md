# Repository Guidelines

## Project Structure & Module Organization

Core runtime code lives in [`src/`](/Users/koltenluca/code-github/code-helm/src):
- `src/index.ts` wires the Discord bot, Codex App Server client, SQLite repos, and runtime orchestration.
- `src/discord/` contains Discord-facing behavior such as commands, transcript rendering, approvals, and thread handling.
- `src/codex/` contains JSON-RPC transport, protocol types, and session control.
- `src/db/` holds migrations, SQLite client setup, and repos.
- `src/domain/` contains product rules such as session ownership and approval semantics.

Tests mirror runtime areas under [`tests/`](/Users/koltenluca/code-github/code-helm/tests). User-facing docs live under [`docs/`](/Users/koltenluca/code-github/code-helm/docs), including setup and demo-support guides such as [`docs/discord-bot-setup.md`](/Users/koltenluca/code-github/code-helm/docs/discord-bot-setup.md) and [`docs/demo-storyboard.md`](/Users/koltenluca/code-github/code-helm/docs/demo-storyboard.md). Design docs and plans live in [`docs/superpowers/specs/`](/Users/koltenluca/code-github/code-helm/docs/superpowers/specs) and [`docs/superpowers/plans/`](/Users/koltenluca/code-github/code-helm/docs/superpowers/plans).

## Build, Test, and Development Commands

- `bun install` installs dependencies and is the only supported lockfile workflow for this repo.
- `bun run dev` starts the local daemon from `src/index.ts`.
- `bun run migrate` applies SQLite migrations using the current environment/config overrides.
- `bun test` runs the full Bun test suite.
- `bun test tests/index.test.ts` runs a focused test file during iteration.
- `bun run typecheck` runs `tsc --noEmit`.

Use Bun for all TypeScript and JavaScript work in this repository. Do not add or regenerate `package-lock.json`; dependency lock state lives in [`bun.lock`](/Users/koltenluca/code-github/code-helm/bun.lock).

## Coding Style & Naming Conventions

Follow the existing TypeScript style:
- 2-space indentation
- semicolons enabled
- ESM imports
- `camelCase` for functions/locals, `PascalCase` for types, `SCREAMING_SNAKE_CASE` for env vars

Prefer small helpers over inline branching when orchestration logic grows. Keep Discord text renderers in `src/discord/` and product-policy logic in `src/domain/`.

## Testing Guidelines

This repo uses `bun:test`. Add tests next to the relevant subsystem using `*.test.ts` naming, for example `tests/discord/transcript.test.ts`.

Favor behavior-level tests over helper-only assertions when touching event ordering, approvals, snapshot reconciliation, or status-card updates. Before finishing work, run:
- `bun test`
- `bun run typecheck`

## Commit & Pull Request Guidelines

Commits follow Conventional Commit style seen in history, for example:
- `feat: wire codehelm v1 application`
- `fix(approval): preserve terminal status and metadata`
- `docs: align task 8 runtime guidance`

PRs should include:
- a short problem statement
- the chosen approach and tradeoffs
- verification commands run
- screenshots or Discord transcript snippets when UI/thread output changes

## Security & Configuration Tips

Never commit real bot tokens or `.env` secrets. Normal user setup should go through `code-helm onboard`; handwritten env overrides are for development, troubleshooting, and legacy compatibility only. `WORKDIRS_JSON` paths must stay under `WORKSPACE_ROOT`; keep test data in isolated directories such as `code-agent-helm-example/.codehelm/`.

When restarting an independent `agent-browser` session, keep all browser state rooted under `/Users/koltenluca/code-github/code-agent-helm-example`. That includes `HOME`, `XDG_CACHE_HOME`, the persistent `--profile` directory, and screenshot/artifact paths (for example `.agent-browser-home`, `.agent-browser-home/.cache`, `.agent-browser-profile`, and `.agent-browser-artifacts`). Reuse the same `--session` and `--session-name` when you need Discord login state to persist; `HOME` and cache alone are not sufficient.

## Browser Automation

For browser end-to-end work, use an explicit subagent and keep it on a cheaper model unless the task clearly needs more reasoning. Browser sessions consume context quickly; isolate that work.

Run browser tests in `--headed` mode by default. Always reuse an existing `agent-browser` session when one already exists; if a suitable session is available, do not create a new browser session.

Treat `agent-browser` as operating on its own managed tab, not “whatever Chrome window is visible.” Before issuing `open`, first check the current target with `tab list`, `get url`, and `get title`. If the session is already on the correct page, do not call `open` again. If recovery is needed, reuse the existing blank tab instead of spawning more tabs.

Use `snapshot` sparingly because large pages such as Discord can consume thousands of tokens per call. Prefer `get url`, `get title`, `click`, `press`, `wait`, and `screenshot`; use `snapshot -i` only when you need fresh element refs.

Keep browser interaction pacing tight. Do not insert arbitrary fixed delays between typing a command, selecting a slash-command candidate, and sending it. Wait only at real async boundaries such as “the slash listbox appeared”, “the command token appeared”, or “the response content rendered”. In normal end-to-end runs, avoid debug-only screenshots, DOM evals, and extra verification steps after every micro-action unless the task is specifically debugging browser behavior.

When restarting a browser test because recovery is necessary, first close the existing `agent-browser` daemon/session, then relaunch with the same rooted `HOME`, cache, `--profile`, `--session`, and `--session-name`. After relaunch, verify the Chrome `user-data-dir` is the fixed `.agent-browser-profile`, not a temporary directory under `/var/...`.

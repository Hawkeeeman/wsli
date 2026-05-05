# wsli

CLI for Wealthsimple: read-only GraphQL and Trade REST (accounts, positions, portfolio, funding), `preview-buy`, live **buy** (market/limit), and **sell** with `--confirm`. Node 20+. Repo: [github.com/Hawkeeeman/wsli](https://github.com/Hawkeeeman/wsli).

## Install

```bash
git clone https://github.com/Hawkeeeman/wsli.git
cd wsli
npm install
```

The root **`wsli`** script (same behavior as **`wsli.mjs`**) rebuilds from `src/` when `dist/` is missing or stale, then runs the CLI.

## Run

From the repo directory (no `PATH` setup). If the shell says `command not found: wsli`, use `./wsli` or `npm run wsli --` instead of bare `wsli`.

```bash
./wsli --help
npm run wsli -- --help
```

To type `wsli` from anywhere: add the clone directory to `PATH`, or run `npm link` in the repo and ensure npm’s global bin is on `PATH` (`npm prefix -g`). Alternatives: `npm install -g .` from the repo, or `npm install -g wsli` if published.

## Session

Default session file: **`~/.config/wsli/session.json`**. Print the path: `wsli session-path`.

## Commands

Use `./wsli --help` and `./wsli <command> --help` for details.

| Area | Commands |
|------|----------|
| Session | `setup`, `snippet`, `import-session`, `config-path`, `session-path`, `ping`, `keepalive` |
| Market data | `lookup`, `security`, `restrictions` |
| Account | `accounts`, `positions`, `position-for-symbol`, `portfolio`, `funding` |
| Orders | `preview-buy` (read-only), `buy` (supports `--order market|limit|stop_limit|stop_market`, with `--stop-price` for stop orders), `sell` (supports `--order market|limit`, `--sell-all`, `--confirm` required), `trade-smoke` |

For `buy --order limit`, `buy --order stop_limit`, and `buy --order stop_market`, use whole shares (`--shares` integer). Stop-limit requires both `--stop-price` and `--limit-price`; stop-market requires only `--stop-price`.
| Diagnostics | `logs`, `history` |

## Flags and environment

CLI: `--token-file`, `--access-token`, `--refresh-token`. For JSON account summaries use `wsli accounts --json` (optional `--pretty`).

Environment: `WEALTHSIMPLE_ACCESS_TOKEN`, `WEALTHSIMPLE_REFRESH_TOKEN`, `WEALTHSIMPLE_OAUTH_JSON`, `WEALTHSIMPLE_OAUTH_CLIENT_ID`. Set `WSLI_NO_REFRESH` to `1` or `true` to disable OAuth refresh.

## Develop

```bash
npm run dev -- --help
npm run check
```

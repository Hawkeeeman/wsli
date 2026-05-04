# wsli

Source: [github.com/Hawkeeeman/wsli](https://github.com/Hawkeeeman/wsli).

Wealthsimple CLI (Node.js): read-only GraphQL, Trade REST for accounts / positions / portfolio / funding, read-only `preview-buy`, and real market **buy** / **sell** with `--confirm`.

## Requirements

- [Node.js](https://nodejs.org/) 20+

## Install

Clone (HTTPS or SSH), then from that directory:

```bash
git clone https://github.com/Hawkeeeman/wsli.git
cd wsli
npm install
./wsli --help
```

This repo includes a root **`wsli`** script (and **`wsli.mjs`**, the same logic) that rebuilds from `src/` when `dist/` is missing or stale, then runs the CLI. Add the **clone directory** to your `PATH` if you want the bare `wsli` command everywhere (then open a new shell or `source ~/.zshrc`).

**`zsh: command not found: wsli`** — until the repo is on `PATH`, from this directory use any of:

```bash
./wsli ping --json
npm run wsli -- ping --json
npm exec wsli -- ping --json
```

To use the bare `wsli` command: `npm link` in the repo root, then put npm’s global bin on your `PATH` (often `$(npm prefix -g)/bin`; check with `npm prefix -g`). Or: `npm install -g .` from the repo, or `npm install -g wsli` once published.

## Credentials

OAuth bundle is stored at **`~/.config/wsli/session.json`** (see `wsli session-path`).

## Commands

Run `./wsli --help` (or `npm run wsli -- --help`) and the same with `<command> --help`.

Core commands: `setup`, `onboard`, `snippet`, `config-path`, `session-path`, `import-session`, `ping`, `keepalive`, `lookup`, `security`, `restrictions`, `preview-buy`, `accounts`, `positions`, `portfolio`, `funding`, `buy`, `sell` (buy/sell require `--confirm`), `logs`, `history`.

## Env / flags

- `--token-file`, `--access-token`, `--refresh-token`, `--json`
- `WEALTHSIMPLE_ACCESS_TOKEN`, `WEALTHSIMPLE_REFRESH_TOKEN`, `WEALTHSIMPLE_OAUTH_JSON`, `WEALTHSIMPLE_OAUTH_CLIENT_ID`
- `WSLI_NO_REFRESH`: set to `1` / `true` to skip OAuth refresh

## Develop

```bash
npm run dev -- --help
npm run check
```

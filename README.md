# wsprobe

Local CLI and optional web UI for Wealthsimple read-only GraphQL checks, plus Trade REST market buys.

## Install

```bash
pip install -e .
```

## Quick start

```bash
python3 -m wsprobe
python3 -m wsprobe ping
```

## Local web UI

```bash
pip install -e '.[web]'
wsprobe-serve
```

Then open `http://127.0.0.1:8765/`.

## Notes

- GraphQL mutations are blocked in `wsprobe/client.py`.
- OAuth refresh is supported using `refresh_token` when available.
- SnapTrade support is optional (`pip install -e '.[trade]'`).

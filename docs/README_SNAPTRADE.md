# SnapTrade TSX buy (Wealthsimple)

Uses your **test** SnapTrade API key from `.env.secret` to place a market buy for a TSX symbol (e.g. penny stock) in a connected Wealthsimple account.

## Where the SnapTrade CLI stores config

- **Path:** `~/.config/snaptrade/settings.json`
- **Profile:** `profiles.default` with `clientId`, `consumerKey`, `userId`, `userSecret`
- Use `python3 sync_cli_config_to_env.py` to copy these into `.env.secret` (no secrets in repo).

## Setup

1. **`.env.secret`** in this directory with (do not commit; it is in `.gitignore`):

   - `SNAPTRADE_CLIENT_ID` – from SnapTrade dashboard (test key)
   - `SNAPTRADE_CONSUMER_KEY` or `SNAPTRADE_API_KEY` – from SnapTrade dashboard (test key)
   - `SNAPTRADE_USER_ID` – your SnapTrade user id (from registering a user)
   - `SNAPTRADE_USER_SECRET` – that user’s secret (from register response)
   - `SNAPTRADE_ACCOUNT_ID` – optional; if unset, first account from `list_user_accounts` is used

   **Copy from CLI:** run `python3 sync_cli_config_to_env.py` to populate from `~/.config/snaptrade/settings.json`.

2. **Check that vars are set** (without reading the file):

   ```bash
   set -a && source .env.secret && set +a && ./check_snaptrade_env.sh
   ```

   Or: `source .env.secret && test -n "$SNAPTRADE_CLIENT_ID" && echo "key present"`

3. **Install deps**: `pip install -r requirements.txt`

4. **Wealthsimple**: Register a SnapTrade user, open the connection portal URL, connect Wealthsimple, then use that user’s id/secret in `.env.secret`.

## If you see connections but "No accounts" (fix)

**Root cause:** Many **test** API keys (e.g. `LOOMLY-TEST-GLESE`) do **not** sync real brokerage accounts. Connections show as Active, but `GET /accounts` stays empty no matter how often you connect or refresh.

**Fix:** Use a **production** SnapTrade API key:

1. In [SnapTrade Dashboard](https://dashboard.snaptrade.com/api-key) create or copy a **production** key (not the test key).
2. Put production `SNAPTRADE_CLIENT_ID` and `SNAPTRADE_CONSUMER_KEY` in `.env.secret` (or a new CLI profile in `~/.config/snaptrade/settings.json`).
3. Run `python3 sync_cli_config_to_env.py` if you use the CLI config.
4. Open the connection portal and connect Wealthsimple again (same user or new user):
   ```bash
   python3 connect_then_buy.py SMC.TO 10
   ```
   That script opens the portal, waits for the new connection, refreshes, polls for accounts, then places the buy. With a production key, accounts should appear and the order will go through.

If you keep using the test key, use **Alpaca Paper** in the connection portal to test (paper accounts do sync with test keys); for real Wealthsimple TSX trades you need a production key.

## Paper trading (easiest start)

One-time setup, then place paper orders with one command:

1. **Credentials:** Ensure `.env.secret` exists (e.g. run `python3 sync_cli_config_to_env.py`).
2. **Connect Alpaca Paper:** Run `python3 start_paper_trading.py`. The browser opens the SnapTrade portal for Alpaca Paper; sign in with Alpaca (or create a free paper account). The script waits for the connection, refreshes it, and saves the paper account ID.
3. **Place paper orders:** `python3 paper_buy.py [SYMBOL] [UNITS]` (e.g. `python3 paper_buy.py HOD.TO 1`).

No production API key required; test keys work with Alpaca Paper.

## Run

```bash
python3 buy_tsx.py [SYMBOL] [UNITS]
```

- Default: 1 unit of `HOD.TO` (TSX symbol; use `.TO` suffix).
- Example: `python3 buy_tsx.py PBL.TO 10` buys 10 shares of PBL on TSX.
- Sub-$2: `python3 buy_tsx.py SMC.TO 10` (Sulliden Mining, ~C$0.25/share).

**CLI (when accounts show up):**
```bash
snaptrade trade equity --ticker SMC.TO --action BUY --shares 10 --useLastAccount
```

Credentials are loaded from `.env.secret` inside the script; the script checks they are non-empty before calling the API.

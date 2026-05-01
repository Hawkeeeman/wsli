# wsli

Wealthsimple Trade CLI - Manage your Wealthsimple Trade account from the command line.

Converted from Python wsprobe tool to Node.js/TypeScript.

## Features

- **Account Management**: List accounts, balances, and positions
- **Trading**: Place market and limit orders (buy/sell)
- **Security Search**: Look up securities by ticker or name
- **OAuth2 Integration**: Automatic token refresh using Wealthsimple's OAuth flow
- **Session Management**: Import/export session credentials
- **Logging**: Built-in operation and buy/sell history tracking

## Installation

```bash
npm install -g wsli
```

Or install from source:

```bash
git clone <repo>
cd wsli
npm install
npm run build
npm link
```

## Quick Start

1. **Setup credentials** (one-time):

```bash
wsli setup
```

This will:
- Display a JavaScript snippet
- Ask you to paste it into the browser console on https://my.wealthsimple.com
- Prompt you to paste the resulting JSON back into the terminal
- Save your session to `~/.config/wsli/session.json`

2. **List your accounts**:

```bash
wsli accounts
```

3. **View portfolio**:

```bash
wsli portfolio
```

4. **Search for a security**:

```bash
wsli lookup AAPL
wsli lookup VFV.TO
```

5. **Place a buy order** (requires `--confirm`):

```bash
wsli buy VFV.TO --shares 1 --account-type tfsa --confirm
wsli buy AAPL --dollars 100 --account-type tfsa --confirm
```

6. **Place a sell order**:

```bash
wsli sell --symbol VFV.TO --shares 1 --account-type tfsa --confirm
```

## Commands

### `ping`
Test connectivity with Wealthsimple API.

```bash
wsli ping
```

### `accounts`
List all Trade accounts with balances.

```bash
wsli accounts [--json]
```

### `positions`
Show holdings for a specific account.

```bash
wsli positions [--account-type tfsa] [--account-index 1]
```

### `portfolio`
Show all accounts with cash and holdings.

```bash
wsli portfolio [--json]
```

### `lookup <query>`
Search for securities by ticker, name, or ISIN.

```bash
wsli lookup AAPL
wsli lookup "Vanguard S&P 500"
```

### `security <id>`
Get security details by ID (sec-s-...).

```bash
wsli security sec-s-xxxxxxxx
```

### `buy <target>`
Place a buy order. **Requires `--confirm`**.

```bash
# By symbol (supports exchange filtering)
wsli buy VFV.TO --shares 1 --account-type tfsa --confirm
wsli buy TSX:AAPL --shares 10 --account-type tfsa --account-index 1 --confirm

# By dollar amount (fractional shares)
wsli buy AAPL --dollars 100 --account-type tfsa --confirm

# By security ID
wsli buy sec-s-xxxxxxxx --shares 1 --account-id <account-id> --confirm

# Limit order (whole shares only)
wsli buy VFV.TO --shares 10 --limit-price 125.50 --account-type tfsa --confirm
```

### `sell`
Place a sell order. **Requires `--confirm`**.

```bash
wsli sell --symbol VFV.TO --shares 1 --account-type tfsa --confirm
wsli sell --security-id sec-s-xxxxxxxx --shares 10 --account-id <id> --confirm
wsli sell --symbol AAPL --shares 5 --limit-price 150.00 --account-type tfsa --confirm
```

### `config-path` / `session-path`
Show configuration file locations.

```bash
wsli config-path    # ~/.config/wsli/config.json
wsli session-path   # ~/.config/wsli/session.json
```

### `setup`
Interactive credential setup.

```bash
wsli setup
```

### `import-session [file]`
Import session JSON from file or stdin.

```bash
wsli import-session ~/tokens.json
cat tokens.json | wsli import-session
```

### `logs` / `history`
View operation logs or buy history.

```bash
wsli logs [--limit 50] [--clear] [--since 1d]
wsli history [--limit 50] [--symbol AAPL] [--clear]
```

## Options

### Global Options

- `--json` - Output JSON instead of formatted text
- `--access-token <token>` - Use specific access token (skips saved session)
- `--refresh-token <token>` - Use specific refresh token
- `--token-file <path>` - Read tokens from JSON file

### Account Selection

- `--account-id <id>` - Use specific account ID
- `--account-type <type>` - Filter by type (tfsa, rrsp, resp, fhsa, joint, non_registered, etc.)
- `--account-index <n>` - Select Nth account when multiple match the type

### Order Options

- `--shares <n>` - Share quantity
- `--dollars <n>` - Dollar amount (for fractional shares)
- `--limit-price <price>` - Limit price per share
- `--symbol <ticker>` - Specify security by ticker symbol
- `--security-id <id>` - Specify security by ID
- `--confirm` - Required to actually place orders (safety latch)

### Filtering

- `--limit <n>` - Limit output to N items
- `--since <duration>` - Filter by age (30m, 2h, 1d, 45s)
- `--symbol <ticker>` - Filter by symbol
- `--status <status>` - Filter by status

## Environment Variables

You can also configure wsli using environment variables:

```bash
export WEALTHSIMPLE_ACCESS_TOKEN="your_access_token"
export WEALTHSIMPLE_REFRESH_TOKEN="your_refresh_token"
export WEALTHSIMPLE_OAUTH_CLIENT_ID="your_client_id"
export WEALTHSIMPLE_OAUTH_JSON='{"access_token":"...","refresh_token":"..."}'
```

Or combine with command-line options:

```bash
WEALTHSIMPLE_ACCESS_TOKEN="..." wsli accounts
```

## Exchange Filtering

When searching or trading for securities that trade on multiple exchanges, you can filter by exchange:

**Prefix notation:**
```bash
wsli buy TSX:AAPL --shares 1 --account-type tfsa --confirm
wsli lookup NYSE:TLT
```

**Suffix notation (Canadian convention):**
```bash
wsli buy AAPL.TO --shares 1 --account-type tfsa --confirm
```

## Session Management

### Automatic Token Refresh

wsli automatically refreshes your access token when it's near expiry (if you have a refresh_token).

### Manual Session Import

If the automatic setup doesn't work:

1. Open https://my.wealthsimple.com and log in
2. Open DevTools (F12) → Application → Cookies
3. Find `_oauth2_access_v2` cookie and copy its value
4. Create a JSON file:

```json
{
  "access_token": "eyJhbGc...",
  "refresh_token": "your_refresh_token_here"
}
```

5. Import it:

```bash
wsli import-session ~/tokens.json
```

## Configuration Files

- `~/.config/wsli/config.json` - User configuration (optional)
- `~/.config/wsli/session.json` - OAuth session credentials
- `~/.config/wsli/logs.jsonl` - Operation logs
- `~/.config/wsli/buy_history.jsonl` - Buy/sell history

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Watch mode
npm run build -- --watch

# Link for local testing
npm link

# Run directly
node dist/cli.js accounts
```

## Security Notes

- Your access token and refresh token are stored locally in `~/.config/wsli/session.json`
- This file should be protected with appropriate file permissions
- Never commit this file to version control
- The tokens are the same ones used by the Wealthsimple web app

## Comparison to Python wsprobe

This is a Node.js/TypeScript conversion of the Python wsprobe tool with feature parity:

| Feature | wsprobe (Python) | wsli (Node.js) |
|---------|------------------|----------------|
| GraphQL/REST API | ✅ | ✅ |
| OAuth2 refresh | ✅ | ✅ |
| Account listing | ✅ | ✅ |
| Positions | ✅ | ✅ |
| Buy/Sell orders | ✅ | ✅ |
| Limit orders | ✅ | ✅ |
| Fractional shares | ✅ | ✅ |
| Exchange filtering | ✅ | ✅ |
| Session management | ✅ | ✅ |
| Logging | ✅ | ✅ |

## License

MIT

## Disclaimer

This tool is not affiliated with or endorsed by Wealthsimple. Use at your own risk. The authors are not responsible for any financial losses incurred through the use of this software.

Always verify your orders before confirming. The `--confirm` flag exists for your protection.

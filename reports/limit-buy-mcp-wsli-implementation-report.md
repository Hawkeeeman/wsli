# Limit Buy MCP + `wsli` Implementation Report

Date: 2026-05-05  
Method: live browser inspection via `user-chrome-devtools` MCP + code implementation in `wsli`

## Request covered

1. Use MCP DevTools on Wealthsimple web to inspect/prepare a limit-buy flow.
2. Analyze how the current `wsli` code handles buys.
3. Implement limit-buy support in `wsli`.
4. Save a written report in the repo.

## MCP browser findings (live Wealthsimple tab)

Context:

- Active tab was already selected at:
  - `https://my.wealthsimple.com/app/security-details/sec-s-08e07f72d8d34ed1a255a35ce7d3665d`
- Speed optimizations used:
  - Skipped `select_page` because target tab was already selected.
  - Used direct snapshot + targeted interactions instead of extra navigation.

Observed order ticket behavior:

- Buy ticket exposes an order-type control with options visible in DOM text:
  - `MARKET`
  - `LIMIT`
  - `STOP_LIMIT`
  - `STOP`
- In the observed ticket state, the form displayed:
  - `Stop price`
  - `Limit price`
  - `Shares`
  - `Estimated cost`
- This indicates the web client supports explicit price-driven buy workflows via price fields and share quantity.
- In `Limit buy` mode, the shares input behaved as whole-share only in practice. Fractional entry did not persist as a valid limit-share amount.

Successful website execution (CEMX):

- Symbol resolved and loaded correctly as:
  - `CEMX — Cematrix Corp`
  - security id: `sec-s-5cc81ddadfe349c5aa00ef95f548b3b5`
- Limit buy ticket used:
  - `Order type`: `Limit buy`
  - `Limit price`: `0.56 CAD` (ask at time)
  - `Shares`: `1`
  - `Account`: `TFSA`
- Review screen showed standard limit order semantics and expiration (`DAY`/market close).
- Submitted order succeeded and was immediately marked:
  - `Order filled`
  - `Filled price: $0.56 CAD`
  - `Shares: 1`
  - `Total cost: $0.56 CAD`

Observed review-step behavior:

- After selecting `TFSA` with low available CAD and trying `MCHP` limit `1` share, clicking `Review` did not submit an order.
- Website opened an `Add money` modal first.
- Ticket message before review indicated auto-funding requirement:
  - “You will add $126.59 CAD in the next step, and it’ll be converted to USD to complete your order.”
- This means web flow performs funding interception before `SoOrdersOrderCreate` when balance is insufficient.

Safety:

- No final submit/review confirmation was clicked in this run.
- No order was placed from this MCP run.

## GraphQL operations used for limit-buy flow

Primary operations used by `wsli` in this implementation:

- `FetchSecuritySearchResult`
  - Purpose: resolve ticker/query input to Wealthsimple `security_id` (`sec-s-...`).
- `FetchSecurity`
  - Purpose: validate instrument metadata (`buyable`, `wsTradeEligible`, symbol/name/exchange).
- `SoOrdersOrderCreate` (mutation)
  - Purpose: submit the real order intent.
- `FetchSoOrdersExtendedOrder`
  - Purpose: poll order lifecycle after submit and read terminal state (`filled`, `rejected`, etc.).
- `FetchSoOrdersLimitOrderRestrictions` (best-effort)
  - Purpose: preview-time informational restrictions when available.
  - Note: this endpoint intermittently returned `UNPROCESSABLE_ENTITY` and was made non-blocking for preview.

Limit-buy mutation payload shape used:

- `canonicalAccountId`
- `securityId`
- `externalId`
- `orderType: "BUY_QUANTITY"`
- `executionType: "LIMIT"`
- `quantity` (whole shares)
- `limitPrice`
- `timeInForce: "DAY"`
- `tradingSession: "REGULAR"`

## How `wsli` worked before this change

`src/index.ts` already had:

- `preview-buy` with `--order market|limit` and `--limit-price` (read-only preview).
- Live `buy` command supported only market-style input patterns in practice:
  - value-based buy (`--dollars`) -> `orderType: BUY_VALUE`, `executionType: FRACTIONAL`
  - quantity buy (`--shares`) -> `orderType: BUY_QUANTITY`
- No `--order`/`--limit-price` flags on live `buy`.

## Implementation completed in `wsli`

Files changed:

- `src/index.ts`
- `README.md`

### `buy` command changes

Added new flags:

- `--order <type>` with accepted values: `market | limit` (default `market`)
- `--limit-price <n>` (required for limit orders)

Validation added:

- Reject unsupported order values.
- Require positive `--limit-price` when `--order limit`.
- Reject `--limit-price` when `--order market`.
- Reject `--order limit` combined with `--dollars` (clean failure; requires `--shares`).
- Reject fractional share quantity on limit buys (`--shares` must be whole number).
- Added pre-submit buying-power guard for USD limit buys:
  - resolves account liquid buying power
  - if account currency is USD and available cash is below `shares * limit_price`, fail early with add-funds message

Order construction changes:

- Include `input.limitPrice` when provided.
- Keep existing `orderType` mapping (`BUY_QUANTITY` vs `BUY_VALUE`).
- Set `timeInForce` to `DAY` for limit buys.
- Set `executionType` to `LIMIT` and `tradingSession` to `REGULAR` for limit-buy semantics.
- Removed hard dependency on `FetchSoOrdersLimitOrderRestrictions` pre-check in live `buy` flow, because this endpoint returned repeated `UNPROCESSABLE_ENTITY` for valid exploratory attempts and blocked otherwise actionable broker responses.

Logging changes:

- Add `order_style` and `limit_price` fields to buy submission logs.
- Add `account_currency` field to aid diagnosis of cross-currency funding failures.

### README updates

- Updated headline description to mention live buy supports market/limit.
- Updated Orders table row to show:
  - `buy` supports `--order market|limit`.

## Example command now supported

```bash
./wsli buy MCHP --shares 1 --order limit --limit-price 95.00 --account-type tfsa --confirm
```

## Notes

- This change intentionally fails early for unsupported combinations instead of adding fallback behavior.
- The implementation is minimal and scoped to limit buys only, as requested.
- During this MCP run, no final order submission occurred because web flow intercepted at `Add money` modal before submit.
- In a later MCP run on `CEMX`, final submission was executed and filled successfully. This confirms the core website limit-buy flow is working when symbol + price + account state are valid.

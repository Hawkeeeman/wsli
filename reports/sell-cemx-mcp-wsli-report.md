# CEMX Sell Execution + `wsli` Sell Infrastructure Report

Date: 2026-05-05

## What was completed

1. Used `user-chrome-devtools` MCP on live Wealthsimple to submit a sell order for **1 CEMX share**.
2. Inspected `wsli` sell implementation and found a blocking issue in the REST path used for symbol lookup.
3. Implemented a sell-path refactor in `wsli` to the GraphQL `SoOrdersOrderCreate` flow.
4. Used `wsli` to sell the remaining **2 CEMX shares** successfully.

## MCP browser execution (first share)

- Active ticker page: `CEMX — Cematrix Corp`.
- Holdings before action: `3 shares`.
- Order ticket configuration used:
  - Side: `Sell`
  - Order type: `Limit`
  - Limit price: `0.55 CAD`
  - Shares: `1`
  - Account: `TFSA`
- Final submit executed from review step.
- Fill confirmation shown in-page:
  - `Order filled`
  - `Filled price: $0.55 CAD`
  - `Shares: 1`
- Holdings after this fill: `2 shares`.

## Root cause in prior `wsli` sell flow

Previous `sell` command behavior in `src/index.ts`:

- Used Trade REST lookup: `GET /securities?query=<symbol>`
- In this environment, that endpoint returned `404`, causing sell to fail before order submission.
- Sell path also diverged from the GraphQL order-create infrastructure used by `buy`.

Observed failure before fix:

- `./wsli sell --symbol CEMX --shares 2 --account-type tfsa --confirm`
- Result: `Error: /securities?query=CEMX HTTP 404: {}`

## GraphQL operations used for sell flow

Primary operations used by the refactored sell path:

- `FetchSecuritySearchResult`
  - Purpose: resolve ticker to `security_id` when user passes symbol.
- `SoOrdersOrderCreate` (mutation)
  - Purpose: submit the real sell order.
- `FetchSoOrdersExtendedOrder`
  - Purpose: poll order status after submission and return final lifecycle data.

Sell mutation payload shape used:

- `canonicalAccountId`
- `securityId`
- `externalId`
- `orderType: "SELL_QUANTITY"`
- `executionType: "LIMIT" | "REGULAR" | "FRACTIONAL"` (based on order mode and quantity precision)
- `quantity`
- optional `limitPrice` (for limit sells)
- `timeInForce: "DAY"` for whole-share sells
- `tradingSession: "REGULAR"` for limit sells

## Code changes made

Files changed:

- `src/index.ts`
- `README.md`

### `src/index.ts` sell refactor

- Added positional target argument for `sell` (ticker or security id), matching `buy` ergonomics.
- Added sell flags:
  - `--order <type>` (`market|limit`, default `market`)
  - `--limit-price <n>` (required for limit sell)
- Replaced REST sell path with GraphQL `SoOrdersOrderCreate`:
  - Security resolution now uses existing `resolveSecurityIdArg(...)`.
  - Sell submission no longer depends on `trade-service` REST symbol lookup endpoints.
  - Input built as:
    - `orderType: "SELL_QUANTITY"`
    - `executionType: LIMIT | REGULAR | FRACTIONAL` depending on order mode and share precision
    - `timeInForce: "DAY"` for whole-share orders
    - `tradingSession: "REGULAR"` for limit sells
    - `quantity` and optional `limitPrice`
- Reused `waitForOrderStatus(...)` for post-submit completion polling.
- Generalized rejection handling from buy-only to shared `assertOrderNotRejected(...)`.
- Added sell-specific logging entries (`sell_submit_attempt`) and kept history journaling.

### `README.md`

- Updated Orders section to state `sell` supports `--order market|limit`.

## CLI execution (remaining shares)

Executed after code change:

```bash
./wsli sell CEMX --shares 2 --order limit --limit-price 0.55 --account-type tfsa --confirm
```

Result:

- `status: filled`
- `submittedQuantity: 2.0000`
- `averageFilledPrice: 0.5500`
- `filledQuantity: 2.0000`
- `securityId: sec-s-5cc81ddadfe349c5aa00ef95f548b3b5`

## Final state

- 1 share sold through browser MCP.
- 2 shares sold through `wsli` after sell-path refactor.
- CEMX position fully exited.

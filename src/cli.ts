#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Readable } from 'stream';
import { createInterface } from 'readline';
import { graphqlRequest, identityIdForGraphQL, OAuthBundle, formatJSON } from './client.js';
import {
  jwtExpUnix,
  accessTokenNeedsRefresh,
  refreshAccessToken,
  getTokenInfo,
  getSessionInfo,
  AuthRequestError,
  jitterDelay,
  DEFAULT_OAUTH_CLIENT_ID,
} from './oauth.js';
import {
  loadOAuthBundle,
  resolveAccessToken,
  resolveAccessTokenForceRefresh,
  ensureFreshAccessToken,
  CONFIG_FILE,
  SESSION_FILE,
  persistBundle,
} from './credentials.js';
import {
  listAccounts,
  listPositions,
  searchSecurities,
  symbolToSecurityId,
  getSecurity,
  placeMarketBuy,
  placeMarketSell,
  accountTypeDisplay,
  formatMoney,
  pickTradeAccountId,
} from './trade.js';
import {
  FETCH_IDENTITY_PACKAGES,
  FETCH_SECURITY,
  FETCH_SECURITY_QUOTES,
  FETCH_SO_ORDERS_LIMIT_ORDER_RESTRICTIONS,
  FETCH_SECURITY_SEARCH,
} from './queries.js';
import { tokenFingerprint, maskSecretValue, sanitizeForLog, isoToUnix, parseSinceSeconds, normalizeSecurityId, bundleFromPastedText } from './utils.js';

const PACKAGE_DIR = path.resolve(__dirname);
const CONFIG_DIR = path.join(os.homedir(), '.config', 'wsli');
const LOG_FILE = path.join(CONFIG_DIR, 'logs.jsonl');
const BUY_HISTORY_FILE = path.join(CONFIG_DIR, 'buy_history.jsonl');
const SESSION_ID = crypto.randomUUID().slice(0, 12);

function expandHome(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return filePath.replace('~', os.homedir());
  }
  return filePath;
}

interface LogEntry {
  ts_utc?: string;
  session_id?: string;
  level?: string;
  event: string;
  [key: string]: unknown;
}

interface BuyHistoryEntry {
  ts_utc?: string;
  command?: string;
  status?: string;
  account_id?: string;
  security_id?: string;
  symbol?: string;
  requested_shares?: number;
  requested_value?: number;
  limit_price?: number;
  submitted_quantity?: number;
  submitted_value?: number;
  filled_quantity?: number;
  average_filled_price?: number;
  order_id?: string;
  external_id?: string;
}

function appendLog(entry: LogEntry): void {
  const payload: LogEntry = { ...entry };
  payload.ts_utc = new Date().toISOString();
  payload.session_id = SESSION_ID;
  payload.level = payload.level || 'info';

  const sanitized = sanitizeForLog(payload) as LogEntry;

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(sanitized) + '\n', 'utf-8');
}

function readLogs(limit: number): LogEntry[] {
  if (limit <= 0 || !fs.existsSync(LOG_FILE)) {
    return [];
  }

  const lines = fs.readFileSync(LOG_FILE, 'utf-8').split(/\r?\n/);
  const out: LogEntry[] = [];

  for (const ln of lines) {
    const s = ln.trim();
    if (!s) {
      continue;
    }
    try {
      const row = JSON.parse(s) as LogEntry;
      if (typeof row === 'object' && row !== null) {
        out.push(row);
      }
    } catch {
      // skip invalid lines
    }
  }

  if (out.length > limit) {
    return out.slice(-limit);
  }
  return out;
}

function appendBuyHistory(entry: BuyHistoryEntry): void {
  const payload: BuyHistoryEntry = { ...entry };
  payload.ts_utc = new Date().toISOString();

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.appendFileSync(BUY_HISTORY_FILE, JSON.stringify(payload) + '\n', 'utf-8');

  appendLog({
    event: 'buy_history_append',
    level: 'info',
    status: payload.status || 'unknown',
    symbol: payload.symbol,
    account_id: payload.account_id,
    order_id: payload.order_id,
  });
}

function readBuyHistory(limit: number): BuyHistoryEntry[] {
  if (limit <= 0 || !fs.existsSync(BUY_HISTORY_FILE)) {
    return [];
  }

  const lines = fs.readFileSync(BUY_HISTORY_FILE, 'utf-8').split(/\r?\n/);
  const out: BuyHistoryEntry[] = [];

  for (const ln of lines) {
    const s = ln.trim();
    if (!s) {
      continue;
    }
    try {
      const row = JSON.parse(ln) as BuyHistoryEntry;
      if (typeof row === 'object' && row !== null) {
        out.push(row);
      }
    } catch {
      // skip invalid lines
    }
  }

  if (out.length > limit) {
    return out.slice(-limit);
  }
  return out;
}

// Command handlers
async function cmdPing(args: ParsedArgs): Promise<number> {
  const { bundle, persistPath } = loadOAuthBundle({
    accessToken: args['access-token'] as string | undefined,
    refreshToken: args['refresh-token'] as string | undefined,
    tokenFile: args['token-file'] as string | undefined,
  });

  const token = await ensureFreshAccessToken(bundle, { persistPath: persistPath });

  const sub = identityIdForGraphQL(token, bundle);
  if (!sub) {
    if (!token || token.split('.').length !== 3 || !token.startsWith('eyJ')) {
      console.error('Invalid or test token detected. Please log in at https://my.wealthsimple.com, then run wsli again.');
      return 1;
    }
    console.error('Could not read identity id from token (token may be expired or malformed)');
    return 1;
  }

  const { status, body, raw } = await graphqlRequest({
    accessToken: token,
    operationName: 'FetchIdentityPackages',
    query: FETCH_IDENTITY_PACKAGES,
    variables: { id: sub },
    oauthBundle: bundle,
  });

  if (raw) {
    console.error(raw);
    return 1;
  }

  if (args.json) {
    console.log(formatJSON({ http_status: status, body }));
  } else {
    console.log(`HTTP ${status}`);
    if (body) {
      const errs = body.errors;
      const data = body.data;
      if (errs) {
        console.error('errors:');
        console.error(formatJSON(errs));
      }
      if (data !== undefined) {
        console.log(formatJSON(data));
      }
    }
  }

  return status === 200 && !body?.errors ? 0 : 1;
}

async function cmdAccounts(args: ParsedArgs): Promise<number> {
  const { bundle, persistPath } = loadOAuthBundle({
    accessToken: args['access-token'] as string | undefined,
    refreshToken: args['refresh-token'] as string | undefined,
    tokenFile: args['token-file'] as string | undefined,
  });

  let token = await ensureFreshAccessToken(bundle, { persistPath: persistPath });

  try {
    const rows = await listAccounts(token, { oauthBundle: bundle });
  } catch (error) {
    if (error instanceof Error && (error.message.includes('401') || error.message.includes('HTTP 401'))) {
      if (bundle.refresh_token && !args['access-token']) {
        token = await ensureFreshAccessToken(bundle, { persistPath: persistPath, forceRefresh: true });
      }
    }
    throw error;
  }

  const rows = await listAccounts(token, { oauthBundle: bundle });

  if (args.json) {
    console.log(formatJSON({ accounts: rows }));
    return 0;
  }

  if (rows.length === 0) {
    console.error('No Trade accounts returned.');
    return 1;
  }

  console.error('Wealthsimple Trade accounts (GraphQL). Ids work with buy / positions.');
  console.error('');

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const aid = r.id || '—';
    const rawType = r.account_type || r.unified_account_type || '—';
    const label = accountTypeDisplay(r.account_type);

    console.log(`  ${i + 1}. ${label} (${rawType})`);
    console.log(`    account id:       ${aid}`);
    console.log(`    status:           ${r.status || '—'}`);
    console.log(`    buying power:     ${formatMoney(r.buying_power)}`);
    console.log(`    current balance:  ${formatMoney(r.current_balance)}`);
    console.log('');
  }

  return 0;
}

async function cmdPositions(args: ParsedArgs): Promise<number> {
  const { bundle, persistPath } = loadOAuthBundle({
    accessToken: args['access-token'] as string | undefined,
    refreshToken: args['refresh-token'] as string | undefined,
    tokenFile: args['token-file'] as string | undefined,
  });

  let token = await ensureFreshAccessToken(bundle, { persistPath: persistPath });

  const accountId = await pickTradeAccountId(token, {
    explicitAccountId: args['account-id'] as string | undefined,
    accountType: args['account-type'] as string | undefined,
    accountIndex: typeof args['account-index'] === 'number' ? args['account-index'] : undefined,
    oauthBundle: bundle,
  });

  let positions = await listPositions(token, accountId, { oauthBundle: bundle });
  const accounts = await listAccounts(token, { oauthBundle: bundle });
  const acct = accounts.find((a) => a.id === accountId);

  const label = acct ? accountTypeDisplay(acct.account_type) : '—';

  if (args.json) {
    console.log(
      formatJSON({
        account_id: accountId,
        account_type: acct?.account_type,
        account_label: label,
        positions,
      })
    );
    return 0;
  }

  console.error(`Positions — ${label} — ${accountId}`);
  if (acct) {
    console.error(`Buying power: ${formatMoney(acct.buying_power)}`);
  }
  console.error('');

  if (positions.length === 0) {
    console.error('No open positions in this account.');
    return 0;
  }

  const symW = Math.max(6, ...positions.map((p) => (p.stock?.symbol || '').length));
  console.log(`${'Symbol'.padEnd(symW)}  Qty      Market value (if present)`);

  for (const p of positions) {
    const sym = p.stock?.symbol || '—';
    const qty = p.quantity;
    const mbv = formatMoney(p.market_book_value);
    console.log(`${sym.padEnd(symW)}  ${String(qty).padStart(7)}  ${mbv}`);
  }

  return 0;
}

async function cmdPortfolio(args: ParsedArgs): Promise<number> {
  const { bundle, persistPath } = loadOAuthBundle({
    accessToken: args['access-token'] as string | undefined,
    refreshToken: args['refresh-token'] as string | undefined,
    tokenFile: args['token-file'] as string | undefined,
  });

  let token = await ensureFreshAccessToken(bundle, { persistPath: persistPath });

  const accounts = await listAccounts(token, { oauthBundle: bundle });
  const blocks: Array<{ account: typeof accounts[0]; positions: ReturnType<typeof listPositions> extends Promise<infer T> ? T : never }> = [];

  for (const acc of accounts) {
    const aid = acc.id?.trim();
    if (!aid) {
      continue;
    }

    let positions: Awaited<ReturnType<typeof listPositions>> = [];
    try {
      positions = await listPositions(token, aid, { oauthBundle: bundle });
    } catch {
      positions = [];
    }

    blocks.push({ account: acc, positions });
  }

  if (args.json) {
    console.log(formatJSON({ portfolio: blocks }));
    return 0;
  }

  console.error('Portfolio (Wealthsimple Trade — cash + holdings per account)');
  console.error('');

  for (const block of blocks) {
    const acc = block.account;
    const positions = block.positions;
    const aid = acc.id;
    const rawType = acc.account_type || acc.unified_account_type;
    const label = accountTypeDisplay(acc.account_type);

    console.log(`=== ${label} (${rawType}) ===`);
    console.log(`account id:        ${aid}`);
    console.log(`buying power:      ${formatMoney(acc.buying_power)}`);
    console.log(`current balance:   ${formatMoney(acc.current_balance)}`);
    console.log(`net deposits:    ${formatMoney(acc.net_deposits)}`);
    console.error('');

    if (positions.length === 0) {
      console.log('  (no positions)');
    } else {
      const symW = Math.max(6, ...positions.map((p) => (p.stock?.symbol || '').length));
      console.log(`  ${'Symbol'.padEnd(symW)}  Qty      Market book value`);

      for (const p of positions) {
        const sym = p.stock?.symbol || '—';
        const qty = p.quantity;
        const mbv = formatMoney(p.market_book_value);
        console.log(`  ${sym.padEnd(symW)}  ${String(qty).padStart(7)}  ${mbv}`);
      }
    }

    console.log('');
  }

  return 0;
}

async function cmdLookup(args: ParsedArgs): Promise<number> {
  const q = (args.query as string | undefined)?.trim() || '';
  if (!q) {
    console.error('Enter a search string (ticker, name, or ISIN). Example: wsli lookup AAPL');
    return 1;
  }

  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));

  const { bundle, persistPath } = loadOAuthBundle({
    accessToken: args['access-token'] as string | undefined,
    refreshToken: args['refresh-token'] as string | undefined,
    tokenFile: args['token-file'] as string | undefined,
  });

  const token = await ensureFreshAccessToken(bundle, { persistPath: persistPath });

  const { status, body: payload, raw } = await graphqlRequest({
    accessToken: token,
    operationName: 'FetchSecuritySearchResult',
    query: FETCH_SECURITY_SEARCH,
    variables: { query: q },
    oauthBundle: bundle,
  });

  if (raw) {
    console.error(raw);
    return 1;
  }

  if (!payload || typeof payload !== 'object') {
    console.error(`Security lookup failed (HTTP ${status}).`);
    return 1;
  }

  if (payload.errors) {
    console.error(formatJSON(payload.errors));
    return 1;
  }

  const data = payload.data as Record<string, unknown> | undefined;
  const block = data?.securitySearch as Record<string, unknown> | undefined;
  let results: Record<string, unknown>[] = [];

  if (block && typeof block === 'object' && block.results && Array.isArray(block.results)) {
    results = block.results
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .slice(0, limit);
  }

  if (args.json) {
    console.log(formatJSON({ http_status: status, query: q, errors: payload.errors, results }));
    return status !== 200 || payload.errors ? 1 : 0;
  }

  console.error(`HTTP ${status}`);

  if (payload.errors) {
    console.error('errors:');
    console.error(formatJSON(payload.errors));
    return 1;
  }

  if (results.length === 0) {
    console.error('No results (try a different search string).');
    return 1;
  }

  // Sort with exact symbol match first
  const qUpper = q.toUpperCase();
  for (const r of results) {
    const stock = r.stock as Record<string, unknown> | undefined;
    const sym = stock?.symbol;
    if (typeof sym === 'string' && sym.toUpperCase() === qUpper) {
      (r as Record<string, unknown>)._exact_symbol_match = true;
    }
  }

  results.sort((a, b) => {
    const aExact = Boolean((a as Record<string, unknown>)._exact_symbol_match);
    const bExact = Boolean((b as Record<string, unknown>)._exact_symbol_match);
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    const aSym = String(((a as Record<string, unknown>).stock as Record<string, unknown> | undefined)?.symbol || '');
    const bSym = String(((b as Record<string, unknown>).stock as Record<string, unknown> | undefined)?.symbol || '');
    return aSym.localeCompare(bSym);
  });

  for (const r of results) {
    delete (r as Record<string, unknown>)._exact_symbol_match;
  }

  const nameW = Math.max(
    'Name'.length,
    ...results.map((x) => String(((x as Record<string, unknown>).stock as Record<string, unknown> | undefined)?.name || '').length)
  );
  const symW = Math.max(
    'Symbol'.length,
    ...results.map((x) => String(((x as Record<string, unknown>).stock as Record<string, unknown> | undefined)?.symbol || '').length)
  );

  console.log(`${'Symbol'.padEnd(symW)}  ${'Name'.padEnd(nameW)}  Exchange  Security id`);

  for (const r of results) {
    const stock = r.stock as Record<string, unknown> | undefined;
    const sym = stock?.symbol || '—';
    const name = String(stock?.name || '').slice(0, 80) || '—';
    const ex = stock?.primaryExchange || '—';
    const sid = r.id || '—';
    console.log(`${String(sym).padEnd(symW)}  ${name.padEnd(nameW)}  ${ex}  ${sid}`);
  }

  console.log('');
  console.log(
    'Use  wsli security <id>  or  wsli buy <id> …  with a security id above.' +
    '\nBalances and holdings:  wsli accounts  /  wsli portfolio'
  );

  return 0;
}

async function cmdSecurity(args: ParsedArgs): Promise<number> {
  const sid = normalizeSecurityId(args.security_id as string);

  const { bundle, persistPath } = loadOAuthBundle({
    accessToken: args['access-token'] as string | undefined,
    refreshToken: args['refresh-token'] as string | undefined,
    tokenFile: args['token-file'] as string | undefined,
  });

  const token = await ensureFreshAccessToken(bundle, { persistPath: persistPath });

  const { status, body: payload, raw } = await graphqlRequest({
    accessToken: token,
    operationName: 'FetchIntraDayChartQuotes',
    query: FETCH_SECURITY_QUOTES,
    variables: {
      id: sid,
      date: null,
      tradingSession: 'OVERNIGHT',
      currency: null,
      period: 'ONE_DAY',
    },
    oauthBundle: bundle,
  });

  if (raw) {
    console.error(raw);
    return 1;
  }

  if (args.json) {
    console.log(formatJSON({ http_status: status, body: payload }));
  } else {
    console.log(`HTTP ${status}`);
    if (payload) {
      const errs = payload.errors;
      const data = payload.data;
      if (errs) {
        console.error('errors:');
        console.error(formatJSON(errs));
      }
      if (data !== undefined) {
        console.log(formatJSON(data));
      }
    }
  }

  return status === 200 && !payload?.errors ? 0 : 1;
}

async function resolveSecurityIdArg(args: ParsedArgs, raw: string): Promise<string> {
  try {
    return normalizeSecurityId(raw);
  } catch {
    // Fall back to search
    const q = (raw || '').trim();
    if (!q) {
      throw new Error('security_id is required (expected sec-s-... or a ticker like GOOG)');
    }

    const { bundle, persistPath } = loadOAuthBundle({
      accessToken: args['access-token'] as string | undefined,
      refreshToken: args['refresh-token'] as string | undefined,
      tokenFile: args['token-file'] as string | undefined,
    });

    const token = await ensureFreshAccessToken(bundle, { persistPath: persistPath });

    const { status, body: payload, raw: rawResp } = await graphqlRequest({
      accessToken: token,
      operationName: 'FetchSecuritySearchResult',
      query: FETCH_SECURITY_SEARCH,
      variables: { query: q },
      oauthBundle: bundle,
    });

    if (rawResp) {
      throw new Error(rawResp);
    }

    if (status !== 200 || !payload || typeof payload !== 'object') {
      throw new Error(`Security lookup failed (HTTP ${status}).`);
    }

    if (payload.errors) {
      throw new Error(formatJSON(payload.errors));
    }

    const data = payload.data as Record<string, unknown> | undefined;
    const block = data?.securitySearch as Record<string, unknown> | undefined;
    const results = block?.results;

    if (!Array.isArray(results) || results.length === 0) {
      throw new Error(`No security found for '${q}'.`);
    }

    const qUpper = q.toUpperCase();
    let exactSymbol:
      | Record<string, unknown>
      | undefined = undefined;

    for (const item of results) {
      if (typeof item === 'object' && item !== null) {
        const stock = item.stock as Record<string, unknown> | undefined;
        const sym = stock?.symbol;
        if (typeof sym === 'string' && sym.toUpperCase() === qUpper) {
          exactSymbol = item;
          break;
        }
      }
    }

    const chosen = exactSymbol || results[0];
    const sid = (chosen as Record<string, unknown>).id;

    if (typeof sid !== 'string' || !sid.startsWith('sec-s-')) {
      throw new Error(
        `Could not resolve a valid security id for '${q}'. Run \`wsli lookup <ticker>\` and pass the sec-s-... id.`
      );
    }

    return sid;
  }
}

async function cmdBuy(args: ParsedArgs): Promise<number> {
  const target = args.target as string | undefined;
  const sym = args.symbol as string | undefined;
  const secId = args['security-id'] as string | undefined;
  const hasSym = Boolean(sym?.trim());
  const hasSec = Boolean(secId?.trim());
  const hasTarget = Boolean(target?.trim());

  if ((hasSym && hasSec) || (hasTarget && (hasSym || hasSec))) {
    console.error('Use exactly one of: positional query, --symbol, or --security-id.');
    return 1;
  }

  if (!hasTarget && !hasSym && !hasSec) {
    console.error('Provide a positional ticker/query, --symbol TICKER, or --security-id sec-s-…');
    return 1;
  }

  const hasShares = args.shares !== undefined;
  const hasDollars = args.dollars !== undefined;

  if (hasShares === hasDollars) {
    console.error('Provide exactly one of --shares N or --dollars USD.');
    return 1;
  }

  if (!args.confirm) {
    console.error(
      'This submits a REAL market BUY to Wealthsimple Trade (trade-service.wealthsimple.com).\n' +
      'It is a direct REST order to trade-service, not GraphQL.\n' +
      'Uses the same OAuth session as the rest of wsli (setup / session.json).\n'
    );
    console.error(
      'Choose the account (TFSA is common for long-term investing; not tax advice):\n' +
      '  wsli accounts\n' +
      '  wsli buy VFV.TO --shares 1 --account-type tfsa --account-index 1 --confirm\n' +
      '  wsli buy VFV.TO --dollars 100 --account-type tfsa --account-index 1 --confirm\n' +
      '  wsli buy --security-id sec-s-… --shares 1 --account-id <id-from-accounts> --confirm\n'
    );
    return 1;
  }

  const { bundle, persistPath } = loadOAuthBundle({
    accessToken: args['access-token'] as string | undefined,
    refreshToken: args['refresh-token'] as string | undefined,
    tokenFile: args['token-file'] as string | undefined,
  });

  let token = await ensureFreshAccessToken(bundle, { persistPath: persistPath });

  const accountId = await pickTradeAccountId(token, {
    explicitAccountId: args['account-id'] as string | undefined,
    accountType: args['account-type'] as string | undefined,
    accountIndex: typeof args['account-index'] === 'number' ? args['account-index'] : undefined,
    oauthBundle: bundle,
    requireTradeOrderable: true,
  });

  let securityId: string;
  if (hasTarget) {
    securityId = await resolveSecurityIdArg(args, String(target).trim());
  } else if (hasSym) {
    securityId = await symbolToSecurityId(token, String(sym).trim());
  } else {
    securityId = normalizeSecurityId(String(secId).trim());
  }

  const shares = hasShares ? Number(args.shares) : undefined;
  const dollars = hasDollars ? Number(args.dollars) : undefined;

  if (shares !== undefined && shares <= 0) {
    console.error('--shares must be positive');
    return 1;
  }

  if (dollars !== undefined && dollars <= 0) {
    console.error('--dollars must be positive');
    return 1;
  }

  const limitPrice = args['limit-price'] !== undefined ? Number(args['limit-price']) : undefined;

  const historyContext: BuyHistoryEntry = {
    account_id: accountId,
    security_id: securityId,
    requested_shares: shares,
    requested_value: dollars,
    limit_price: limitPrice,
  };

  const securityData = await getSecurity(token, securityId);
  const stock = securityData.stock as Record<string, unknown> | undefined;
  const symbol = stock?.symbol as string | undefined;

  historyContext.symbol = symbol;

  try {
    const out = await placeMarketBuy(token, {
      accountId,
      securityId,
      quantity: shares,
      value: dollars,
      limitPrice,
    });

    appendBuyHistory({
      command: 'buy',
      status: out.status,
      account_id: accountId,
      security_id: securityId,
      symbol: symbol,
      requested_shares: shares,
      requested_value: dollars,
      limit_price: limitPrice,
      submitted_quantity: out.submittedQuantity,
      submitted_value: out.submittedNetValue,
      filled_quantity: out.filledQuantity,
      average_filled_price: out.averageFilledPrice,
      order_id: out.orderId,
      external_id: out.externalId,
    });

    if (args.json) {
      console.log(formatJSON({ ok: true, order: out }));
    } else {
      console.error('Order submitted to Wealthsimple Trade (direct REST). Final status:');
      console.log(formatJSON(out));
    }

    return 0;
  } catch (error) {
    console.error(String(error));
    return 1;
  }
}

async function cmdSell(args: ParsedArgs): Promise<number> {
  const sym = args.symbol as string | undefined;
  const secId = args['security-id'] as string | undefined;
  const hasSym = Boolean(sym?.trim());
  const hasSec = Boolean(secId?.trim());

  if (hasSym && hasSec) {
    console.error('Use either --symbol or --security-id, not both.');
    return 1;
  }

  if (!hasSym && !hasSec) {
    console.error('Provide --symbol TICKER or --security-id sec-s-…');
    return 1;
  }

  if (!args.confirm) {
    console.error(
      'This submits a REAL market SELL to Wealthsimple Trade (trade-service.wealthsimple.com).\n' +
      'It is a direct REST order to trade-service, not GraphQL.\n' +
      'Uses the same OAuth session as the rest of wsli (setup / session.json).\n'
    );
    console.error(
      'Choose the account:\n' +
      '  wsli accounts\n' +
      '  wsli sell --symbol VFV.TO --shares 1 --account-type tfsa --account-index 1 --confirm\n' +
      '  wsli sell --security-id sec-s-… --shares 1 --account-id <id-from-accounts> --confirm\n'
    );
    return 1;
  }

  const { bundle, persistPath } = loadOAuthBundle({
    accessToken: args['access-token'] as string | undefined,
    refreshToken: args['refresh-token'] as string | undefined,
    tokenFile: args['token-file'] as string | undefined,
  });

  let token = await ensureFreshAccessToken(bundle, { persistPath: persistPath });

  const accountId = await pickTradeAccountId(token, {
    explicitAccountId: args['account-id'] as string | undefined,
    accountType: args['account-type'] as string | undefined,
    accountIndex: typeof args['account-index'] === 'number' ? args['account-index'] : undefined,
    oauthBundle: bundle,
    requireTradeOrderable: true,
  });

  let securityId: string;
  if (hasSym) {
    securityId = await symbolToSecurityId(token, String(sym).trim());
  } else {
    securityId = normalizeSecurityId(String(secId).trim());
  }

  const shares = Number(args.shares);
  if (shares <= 0) {
    console.error('--shares must be positive');
    return 1;
  }

  const limitPrice = args['limit-price'] !== undefined ? Number(args['limit-price']) : undefined;

  try {
    const out = await placeMarketSell(token, {
      accountId,
      securityId,
      quantity: shares,
      limitPrice,
    });

    if (args.json) {
      console.log(formatJSON({ ok: true, order: out }));
    } else {
      console.error('Sell order submitted to Wealthsimple Trade (direct REST). Final status:');
      console.log(formatJSON(out));
    }

    return 0;
  } catch (error) {
    console.error(String(error));
    return 1;
  }
}

function cmdConfigPath(): number {
  console.log(CONFIG_FILE);
  return 0;
}

function cmdSessionPath(): number {
  console.log(SESSION_FILE);
  return 0;
}

function cmdExportSessionSnippet(): number {
  console.error('Copy only the JavaScript below into the browser console (not this shell command).\n');
  const snippetPath = path.join(PACKAGE_DIR, '../src/export_session_console.js');
  if (fs.existsSync(snippetPath)) {
    console.log(fs.readFileSync(snippetPath, 'utf-8'));
  } else {
    console.log('// Snippet not found - it should be at export_session_console.js');
  }
  return 0;
}

async function readPastedJSONFromStdin(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const lines: string[] = [];
  const decoder = new JSONDecoder();

  for await (const line of rl) {
    const cleaned = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
    if (lines.length === 0 && !cleaned.trim()) {
      continue;
    }
    lines.push(cleaned);

    const candidate = lines.join('\n').trim();
    if (!candidate) {
      continue;
    }

    try {
      const start = candidate.indexOf('{');
      if (start < 0) {
        continue;
      }
      const parsed = decoder.rawDecode(candidate.slice(start));
      if (parsed && parsed.remaining.trim() === '') {
        return JSON.stringify(parsed.value);
      }
    } catch {
      // continue accumulating
    }
  }

  const raw = lines.join('\n').trim();
  if (raw) {
    return raw;
  }

  throw new Error('No JSON received. Paste the console output JSON object, then press Enter.');
}

class JSONDecoder {
  rawDecode(text: string): { value: unknown; remaining: string } | null {
    try {
      const idx = text.indexOf('}');
      if (idx === -1) {
        return null;
      }
      const value = JSON.parse(text.slice(0, idx + 1));
      return { value, remaining: text.slice(idx + 1) };
    } catch {
      return null;
    }
  }
}

async function cmdImportSession(args: ParsedArgs): Promise<number> {
  let raw: string;

  const importFile = args.file as string | undefined;
  if (importFile) {
    raw = fs.readFileSync(expandHome(importFile), 'utf-8');
  } else {
    if (process.stdin.isTTY) {
      throw new Error('No JSON input (give a file path or pipe JSON on stdin)');
    }
    raw = await readPastedJSONFromStdin();
  }

  if (!raw.trim()) {
    throw new Error('No JSON input (give a file path or pipe JSON on stdin)');
  }

  const data = bundleFromPastedText(raw);

  // Reject expired tokens
  const tok = data.access_token?.trim() || '';
  if (!tok) {
    throw new Error('No access_token in imported credentials.');
  }

  const exp = jwtExpUnix(tok);
  if (exp !== null) {
    const now = Date.now() / 1000;
    if (exp <= now) {
      throw new Error(
        'Imported access_token is already expired. ' +
        'Re-copy _oauth2_access_v2 from a currently logged-in my.wealthsimple.com tab.'
      );
    }
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');

  console.error(`Saved credentials to ${SESSION_FILE}`);
  return 0;
}

async function cmdSetup(args: ParsedArgs): Promise<number> {
  console.error(
    'Step 1: open https://my.wealthsimple.com and sign in.\n' + 'Step 2: paste this snippet into DevTools Console and run it.\n'
  );

  await cmdExportSessionSnippet();

  console.error('\n\nStep 3: paste the console output JSON below, then press Enter:\n');

  try {
    const raw = await readPastedJSONFromStdin();
    const data = bundleFromPastedText(raw);

    // Reject expired tokens
    const tok = data.access_token?.trim() || '';
    if (!tok) {
      throw new Error('No access_token in imported credentials.');
    }

    const exp = jwtExpUnix(tok);
    if (exp !== null) {
      const now = Date.now() / 1000;
      if (exp <= now) {
        throw new Error(
          'Imported access_token is already expired. ' +
          'Re-copy _oauth2_access_v2 from a currently logged-in my.wealthsimple.com tab.'
        );
      }
    }

    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf-8');

    console.error(`Saved credentials to ${SESSION_FILE}`);
    return 0;
  } catch (error) {
    if (error instanceof Error && error.message === 'Cancelled.') {
      console.error('Cancelled.');
      return 130;
    }
    throw error;
  }
}

async function cmdLogs(args: ParsedArgs): Promise<number> {
  const clear = Boolean(args.clear);

  if (clear) {
    const deleted: string[] = [];
    const missing: string[] = [];

    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
      deleted.push(LOG_FILE);
    } else {
      missing.push(LOG_FILE);
    }

    if (args.json) {
      console.log(formatJSON({ deleted, missing }));
    } else {
      if (deleted.length > 0) {
        console.log('deleted:');
        for (const item of deleted) {
          console.log(`  ${item}`);
        }
      }
      if (missing.length > 0) {
        console.log('already empty:');
        for (const item of missing) {
          console.log(`  ${item}`);
        }
      }
    }
    return 0;
  }

  const limit = Math.max(1, Number(args.limit) || 50);
  const rows = readLogs(limit * 10);
  const levelFilter = (args.level as string | undefined)?.trim().toLowerCase();
  const eventFilter = (args.event as string | undefined)?.trim();

  let cutoff: number | null = null;
  if (args.since) {
    cutoff = parseSinceSeconds(String(args.since));
    if (cutoff !== null) {
      cutoff = Date.now() / 1000 - cutoff;
    }
  }

  const filtered: LogEntry[] = [];
  for (const row of rows) {
    if (levelFilter && row.level?.toLowerCase() !== levelFilter) {
      continue;
    }
    if (eventFilter && !row.event.startsWith(eventFilter.replace(/\*/g, ''))) {
      continue;
    }
    if (cutoff !== null) {
      const ts = isoToUnix(String(row.ts_utc || ''));
      if (ts === null || ts < cutoff) {
        continue;
      }
    }
    filtered.push(row);
  }

  if (filtered.length > limit) {
    filtered.splice(0, filtered.length - limit);
  }

  if (args.json) {
    console.log(formatJSON({ path: LOG_FILE, entries: filtered }));
    return 0;
  }

  console.log(`log path: ${LOG_FILE}`);

  if (filtered.length === 0) {
    console.log('no log entries yet');
    return 0;
  }

  for (const row of filtered) {
    const ts = String(row.ts_utc || 'unknown-time');
    const event = String(row.event || 'event');
    const level = String(row.level || 'info');
    const session = String(row.session_id || '-');

    let line = `${ts}  ${event} level=${level} session=${session}`;

    if (row.cycle !== undefined) {
      line += ` cycle=${row.cycle}`;
    }
    if (row.action !== undefined) {
      line += ` action=${row.action}`;
    }
    if (row.status !== undefined) {
      line += ` status=${row.status}`;
    }

    console.log(line);

    const tb = row.token_before_fp;
    const ta = row.token_after_fp;
    if (tb || ta) {
      console.log(`  token_before=${tb || '-'} token_after=${ta || '-'}`);
    }

    const eb = row.exp_before;
    const ea = row.exp_after;
    const rem = row.remaining_s;
    if (eb || ea || rem !== undefined) {
      console.log(`  exp_before=${eb || '-'} exp_after=${ea || '-'} remaining_s=${rem !== undefined ? rem : '-'}`);
    }

    if (row.message) {
      console.log(`  note=${row.message}`);
    }
  }

  return 0;
}

async function cmdHistory(args: ParsedArgs): Promise<number> {
  const clear = Boolean(args.clear);

  if (clear) {
    const deleted: string[] = [];
    const missing: string[] = [];

    if (fs.existsSync(BUY_HISTORY_FILE)) {
      fs.unlinkSync(BUY_HISTORY_FILE);
      deleted.push(BUY_HISTORY_FILE);
    } else {
      missing.push(BUY_HISTORY_FILE);
    }

    if (args.json) {
      console.log(formatJSON({ deleted, missing }));
    } else {
      if (deleted.length > 0) {
        console.log('deleted:');
        for (const item of deleted) {
          console.log(`  ${item}`);
        }
      }
      if (missing.length > 0) {
        console.log('already empty:');
        for (const item of missing) {
          console.log(`  ${item}`);
        }
      }
    }
    return 0;
  }

  const limit = Math.max(1, Number(args.limit) || 50);
  const rows = readBuyHistory(limit * 10);
  const symbolFilter = (args.symbol as string | undefined)?.trim().toUpperCase();
  const statusFilter = (args.status as string | undefined)?.trim().toLowerCase();
  const accountFilter = (args['account-id'] as string | undefined)?.trim();

  let cutoff: number | null = null;
  if (args.since) {
    cutoff = parseSinceSeconds(String(args.since));
    if (cutoff !== null) {
      cutoff = Date.now() / 1000 - cutoff;
    }
  }

  const filtered: BuyHistoryEntry[] = [];
  for (const row of rows) {
    const sym = String(row.symbol || '').trim().toUpperCase();
    const st = String(row.status || '').trim().toLowerCase();
    const aid = String(row.account_id || '').trim();

    if (symbolFilter && sym !== symbolFilter) {
      continue;
    }
    if (statusFilter && st !== statusFilter) {
      continue;
    }
    if (accountFilter && aid !== accountFilter) {
      continue;
    }
    if (cutoff !== null) {
      const ts = isoToUnix(String(row.ts_utc || ''));
      if (ts === null || ts < cutoff) {
        continue;
      }
    }
    filtered.push(row);
  }

  if (filtered.length > limit) {
    filtered.splice(0, filtered.length - limit);
  }

  if (args.json) {
    console.log(formatJSON({ path: BUY_HISTORY_FILE, entries: filtered }));
    return 0;
  }

  console.log(`buy history path: ${BUY_HISTORY_FILE}`);

  if (filtered.length === 0) {
    console.log('no buy history entries yet');
    return 0;
  }

  for (const row of filtered) {
    const tsUtc = String(row.ts_utc || 'unknown-time');
    const status = String(row.status || 'unknown');
    const symbol = String(row.symbol || '—');
    const securityId = String(row.security_id || '—');
    const accountId = String(row.account_id || '—');

    const quantity = row.filled_quantity !== undefined ? row.filled_quantity : row.submitted_quantity;
    const avgPrice = row.average_filled_price;
    const value = row.submitted_value;

    const parts = [tsUtc, `status=${status}`, `symbol=${symbol}`, `security_id=${securityId}`, `account_id=${accountId}`];

    if (quantity !== undefined) {
      parts.push(`quantity=${quantity}`);
    }
    if (avgPrice !== undefined) {
      parts.push(`avg_price=${avgPrice}`);
    }
    if (value !== undefined) {
      parts.push(`value=${value}`);
    }

    console.log(parts.join('  '));

    const orderId = row.order_id;
    const externalId = row.external_id;
    if (orderId || externalId) {
      console.log(`  order_id=${orderId || '-'} external_id=${externalId || '-'}`);
    }
  }

  return 0;
}

// Type for parsed command-line arguments
interface ParsedArgs {
  [key: string]: string | number | boolean | undefined;
  command?: string;
  json?: boolean;
  confirm?: boolean;
  clear?: boolean;
}

// Argument parser
function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  let positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      let key: string;
      let value: string | boolean = true;

      if (eqIdx !== -1) {
        key = arg.slice(2, eqIdx);
        value = arg.slice(eqIdx + 1);
      } else {
        key = arg.slice(2);
        if (i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
          value = argv[++i]!;
        }
      }

      // Convert key to camelCase for hyphenated args
      const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[camelKey] = value === 'true' ? true : value === 'false' ? false : value;
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      let value: string | boolean = true;

      if (i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
        value = argv[++i]!;
      }

      args[key] = value === 'true' ? true : value === 'false' ? false : value;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    args.command = positional[0];
    if (positional.length > 1) {
      args.query = positional[1];
    }
    if (positional.length > 2) {
      args.target = positional[2];
    }
  }

  return args;
}

// Main entry point
async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  const command = args.command || 'ping';

  // Handle help
  if (command === 'help' || args.help || args.h) {
    printHelp();
    return 0;
  }

  // Handle version
  if (command === 'version' || args.version || args.v) {
    console.log('wsli version 1.0.0');
    return 0;
  }

  switch (command) {
    case 'ping':
      return await cmdPing(args);
    case 'accounts':
      return await cmdAccounts(args);
    case 'positions':
      return await cmdPositions(args);
    case 'portfolio':
      return await cmdPortfolio(args);
    case 'lookup':
      return await cmdLookup(args);
    case 'security':
      return await cmdSecurity(args);
    case 'buy':
      return await cmdBuy(args);
    case 'sell':
      return await cmdSell(args);
    case 'config-path':
      return cmdConfigPath();
    case 'session-path':
      return cmdSessionPath();
    case 'export-session-snippet':
      return cmdExportSessionSnippet();
    case 'import-session':
      return await cmdImportSession(args);
    case 'setup':
      return await cmdSetup(args);
    case 'logs':
      return await cmdLogs(args);
    case 'history':
      return await cmdHistory(args);
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run: wsli help');
      return 1;
  }
}

function printHelp(): void {
  console.log(`
wsli - Wealthsimple Trade CLI

Usage: wsli <command> [options]

Commands:
  ping                          Test connectivity
  accounts                      List Trade accounts (ids, TFSA/RRSP, buying power)
  positions                     Holdings in one Trade account
  portfolio                     All Trade accounts: cash + holdings
  lookup <query>                Search by ticker/name → security ids
  security <id>                 Security details by id
  buy <target> [options]        Place a real market BUY (requires --confirm)
  sell [options]                Place a real market SELL (requires --confirm)
  config-path                   Print config file path
  session-path                  Print session file path
  setup                         Interactive setup
  import-session [file]         Import session JSON
  logs                          Show operational logs
  history                       Show buy history

Options:
  --json                        Output JSON
  --access-token <token>        Use specific access token
  --refresh-token <token>       Use specific refresh token
  --token-file <path>           Read tokens from file
  --confirm                     Confirm dangerous operations
  --account-id <id>             Use specific account
  --account-type <type>         Filter by account type (tfsa, rrsp, etc.)
  --account-index <n>           Select account by index
  --shares <n>                  Share quantity
  --dollars <n>                 Dollar amount
  --limit-price <price>         Limit price
  --symbol <ticker>             Specify by symbol
  --security-id <id>            Specify by security id
  --limit <n>                   Limit output
  --clear                       Clear logs/history
  --since <duration>            Filter by age (30m, 2h, 1d)
  -h, --help                    Show help
  -v, --version                 Show version

Examples:
  wsli setup
  wsli accounts
  wsli lookup AAPL
  wsli buy VFV.TO --shares 1 --account-type tfsa --confirm
  wsli sell --symbol VFV.TO --shares 1 --account-type tfsa --confirm
`);
}

// Run main if this is the executed module
if (require.main === module) {
  const args = process.argv.slice(2);
  main(args)
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { main };

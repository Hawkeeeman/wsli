import { graphqlRequest, identityIdForGraphQL, OAuthBundle } from './client.js';
import {
  FETCH_TRADE_ACCOUNT_LIST,
  FETCH_SECURITY_QUOTES,
  FETCH_SO_ORDERS_EXTENDED_ORDER,
  MUTATION_SO_ORDERS_ORDER_CREATE,
} from './queries.js';

const TRADE_SERVICE_BASE = 'https://trade-service.wealthsimple.com';
const TRANSIENT_ORDER_STATUSES = new Set([
  '',
  'new',
  'pending',
  'queued',
  'accepted',
  'open',
  'submitted',
  'in_progress',
]);

// CLI --account-type aliases → legacy REST account_type values (ca_*), matched after GraphQL mapping.
const ACCOUNT_TYPE_ALIASES: Record<string, string[]> = {
  tfsa: ['ca_tfsa'],
  rrsp: ['ca_rrsp'],
  resp: ['ca_resp', 'ca_individual_resp', 'ca_family_resp'],
  fhsa: ['ca_fhsa'],
  joint: ['ca_joint'],
  non_registered: ['ca_non_registered'],
  margin: ['ca_non_registered'],
  cash: ['ca_non_registered'],
  rrif: ['ca_rrif'],
  lira: ['ca_lira'],
  lrsp: ['ca_lrsp'],
};

// GraphQL Account.unifiedAccountType → ca_* (same labels pickTradeAccountId expects).
const UNIFIED_TO_CA: Record<string, string> = {
  SELF_DIRECTED_TFSA: 'ca_tfsa',
  MANAGED_TFSA: 'ca_tfsa',
  SELF_DIRECTED_RRSP: 'ca_rrsp',
  MANAGED_RRSP: 'ca_rrsp',
  SELF_DIRECTED_SPOUSAL_RRSP: 'ca_rrsp',
  SELF_DIRECTED_NON_REGISTERED: 'ca_non_registered',
  SELF_DIRECTED_NON_REGISTERED_MARGIN: 'ca_non_registered',
  SELF_DIRECTED_JOINT_NON_REGISTERED: 'ca_joint',
  MANAGED_JOINT: 'ca_joint',
  SELF_DIRECTED_FHSA: 'ca_fhsa',
  MANAGED_FHSA: 'ca_fhsa',
  SELF_DIRECTED_INDIVIDUAL_RESP: 'ca_individual_resp',
  SELF_DIRECTED_FAMILY_RESP: 'ca_family_resp',
  SELF_DIRECTED_RESP: 'ca_resp',
  MANAGED_RESP: 'ca_resp',
  SELF_DIRECTED_RRIF: 'ca_rrif',
  SELF_DIRECTED_LIRA: 'ca_lira',
  SELF_DIRECTED_LRSP: 'ca_lrsp',
  SELF_DIRECTED_CRYPTO: 'ca_non_registered',
};

export interface Money {
  amount: number;
  currency: string;
}

export interface Account {
  id: string;
  status: string;
  account_type: string | null;
  unified_account_type: string | null;
  nickname: string | null;
  currency: string | null;
  current_balance: Money | null;
  buying_power: Money | null;
  net_deposits: Money | null;
  trade_custodian: boolean;
}

export interface Position {
  security_id: string;
  symbol: string;
  quantity: number;
  market_book_value?: Money;
  stock?: {
    symbol: string;
    name: string;
  };
}

export interface Order {
  orderId?: string;
  status?: string;
  submittedQuantity?: number;
  submittedNetValue?: number;
  filledQuantity?: number;
  averageFilledPrice?: number;
  externalId?: string;
  accountId?: string;
}

interface TradeServiceRequestOptions {
  accessToken: string;
  jsonBody?: Record<string, unknown>;
  timeoutSeconds?: number;
}

async function tradeServiceRequest(
  method: string,
  path: string,
  options: TradeServiceRequestOptions
): Promise<{ status: number; body: unknown }> {
  const { accessToken, jsonBody, timeoutSeconds = 45 } = options;
  const url = `${TRADE_SERVICE_BASE}${path}`;

  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    origin: 'https://my.wealthsimple.com',
    referer: 'https://my.wealthsimple.com/',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };

  const body = jsonBody ? JSON.stringify(jsonBody) : undefined;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const status = response.status;
    const text = await response.text();

    try {
      const jsonBody = text.trim() ? JSON.parse(text) : {};
      return { status, body: jsonBody };
    } catch {
      const preview = text.split(/\s+/).join(' ');
      const truncated = preview.length > 320 ? preview.slice(0, 320) + '...' : preview;
      return { status, body: { _raw_preview: truncated } };
    }
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutSeconds}s`);
    }

    throw error;
  }
}

export async function searchSecurities(
  accessToken: string,
  query: string
): Promise<Record<string, unknown>[]> {
  const q = encodeURIComponent(query.trim());
  const { status, body } = await tradeServiceRequest('GET', `/securities?query=${q}`, {
    accessToken,
  });

  if (status === 404) {
    // Try GraphQL search fallback
    const gqlStatus = await graphqlSearchSecurities(accessToken, query);
    return gqlStatus;
  }

  if (status !== 200) {
    throw new Error(`securities search HTTP ${status}: ${JSON.stringify(body)}`);
  }

  if (typeof body !== 'object' || body === null || !('results' in body)) {
    throw new Error(`securities search missing results: ${JSON.stringify(body)}`);
  }

  const results = (body as { results: unknown[] }).results;
  if (!Array.isArray(results)) {
    throw new Error(`securities search results is not an array`);
  }

  return results.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
}

async function graphqlSearchSecurities(
  accessToken: string,
  query: string
): Promise<Record<string, unknown>[]> {
  const { FETCH_SECURITY_SEARCH } = await import('./queries.js');

  const { status, body: gqlBody } = await graphqlRequest({
    accessToken,
    operationName: 'FetchSecuritySearchResult',
    query: FETCH_SECURITY_SEARCH,
    variables: { query: query.trim() },
  });

  if (status === 200 && gqlBody && typeof gqlBody === 'object') {
    const data = gqlBody.data as Record<string, unknown> | undefined;
    const securitySearch = data?.securitySearch as Record<string, unknown> | undefined;
    const results = securitySearch?.results;
    if (Array.isArray(results)) {
      return results.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null);
    }
  }

  return [];
}

export async function symbolToSecurityId(accessToken: string, symbol: string): Promise<string> {
  const raw = symbol.trim();
  if (!raw) {
    throw new Error('symbol is empty');
  }

  let exchangeFilter: string | undefined;
  let searchSymbol = raw.toUpperCase();

  // Check for prefix notation: EXCHANGE:SYMBOL
  if (raw.includes(':')) {
    const parts = raw.split(':', 2);
    if (parts.length === 2) {
      exchangeFilter = parts[0]!.trim().toUpperCase();
      searchSymbol = parts[1]!.trim().toUpperCase();
    }
  }

  // Check for suffix notation: SYMBOL.EXCHANGE (only if no prefix was found)
  if (!exchangeFilter && raw.includes('.')) {
    const parts = raw.split('.');
    if (parts.length === 2) {
      const suffix = parts[1]!.trim().toUpperCase();
      const suffixToExchange: Record<string, string> = {
        TO: 'TSX',
        V: 'TSXV',
        N: 'NYSE',
        OQ: 'NASDAQ',
      };
      exchangeFilter = suffixToExchange[suffix] || suffix;
      searchSymbol = parts[0]!.trim().toUpperCase();
    }
  }

  if (!searchSymbol) {
    throw new Error('symbol is empty after parsing exchange filter');
  }

  let rows = await searchSecurities(accessToken, searchSymbol);
  if (rows.length === 0) {
    throw new Error(`No security found for ${JSON.stringify(symbol)}. Try the full ticker (e.g. VFV.TO).`);
  }

  // Filter by exchange if specified
  if (exchangeFilter) {
    const filteredRows: Record<string, unknown>[] = [];
    for (const r of rows) {
      const stock = r.stock as Record<string, unknown> | undefined;
      const exchange = String(stock?.primaryExchange || '').trim().toUpperCase();
      if (exchange.includes(exchangeFilter)) {
        filteredRows.push(r);
      }
    }

    if (filteredRows.length === 0) {
      const availableExchanges: string[] = [];
      for (const r of rows) {
        const stock = r.stock as Record<string, unknown> | undefined;
        const ex = String(stock?.primaryExchange || '').trim();
        const sym = String(stock?.symbol || '').trim();
        if (ex) {
          availableExchanges.push(`${ex} (${sym})`);
        }
      }

      const exchangesStr = availableExchanges.length > 0 ? availableExchanges.join(', ') : 'no exchanges listed';
      throw new Error(
        `No security found for ${JSON.stringify(symbol)} with exchange filter '${exchangeFilter}'. ` +
        `Available exchanges for ${searchSymbol}: ${exchangesStr}`
      );
    }
    rows = filteredRows;
  }

  // Try exact symbol match first
  for (const r of rows) {
    const stock = r.stock as Record<string, unknown> | undefined;
    const rsym = String(stock?.symbol || '').trim().toUpperCase();
    if (rsym === searchSymbol) {
      const rid = r.id;
      if (typeof rid === 'string') {
        return rid;
      }
    }
  }

  // Fall back to first result
  const rid = rows[0]?.id;
  if (typeof rid === 'string') {
    return rid;
  }

  throw new Error('Search returned entries without id');
}

function accountTypeFromUnified(unified: string | null | undefined): string | null {
  if (!unified) {
    return null;
  }
  const u = String(unified).trim();
  if (u in UNIFIED_TO_CA) {
    return UNIFIED_TO_CA[u]!;
  }
  const up = u.toUpperCase();
  if (up.includes('TFSA')) {
    return 'ca_tfsa';
  }
  if (up.includes('FHSA')) {
    return 'ca_fhsa';
  }
  if (up.includes('SPOUSAL') && up.includes('RRSP')) {
    return 'ca_rrsp';
  }
  if (up.includes('RRSP')) {
    return 'ca_rrsp';
  }
  if (up.includes('INDIVIDUAL_RESP')) {
    return 'ca_individual_resp';
  }
  if (up.includes('FAMILY_RESP')) {
    return 'ca_family_resp';
  }
  if (up.includes('RESP')) {
    return 'ca_resp';
  }
  if (up.includes('JOINT') && up.includes('NON_REGISTERED')) {
    return 'ca_joint';
  }
  if (up.includes('NON_REGISTERED') || up.includes('MARGIN')) {
    return 'ca_non_registered';
  }
  if (up.includes('RRIF')) {
    return 'ca_rrif';
  }
  if (up.includes('LIRA')) {
    return 'ca_lira';
  }
  if (up.includes('LRSP')) {
    return 'ca_lrsp';
  }
  return null;
}

function moneyFromGraphQLFragment(m: unknown): Money | null {
  if (typeof m !== 'object' || m === null) {
    return null;
  }
  const amt = (m as Record<string, unknown>).amount;
  const cur = (m as Record<string, unknown>).currency;
  if (amt === undefined && cur === undefined) {
    return null;
  }
  const out: Partial<Money> = {};
  if (amt !== undefined) {
    out.amount = Number(amt);
  }
  if (cur !== undefined) {
    out.currency = String(cur);
  }
  if (out.amount !== undefined && out.currency !== undefined) {
    return out as Money;
  }
  return null;
}

function graphqlAccountToRow(node: Record<string, unknown>): Account {
  const unified = node.unifiedAccountType as string | undefined;
  const mapped = accountTypeFromUnified(unified || null);

  let tradeCustodian = false;
  const custodianAccounts = node.custodianAccounts as unknown[];
  if (Array.isArray(custodianAccounts)) {
    for (const ca of custodianAccounts) {
      if (typeof ca === 'object' && ca !== null) {
        const branch = String((ca as Record<string, unknown>).branch || '').toUpperCase();
        if (branch === 'WS' || branch === 'TR') {
          tradeCustodian = true;
          break;
        }
      }
    }
  }

  const financials = node.financials as Record<string, unknown> | undefined;
  const combined = financials?.currentCombined as Record<string, unknown> | undefined;
  const nlv = moneyFromGraphQLFragment(combined?.netLiquidationValue);
  const nd = moneyFromGraphQLFragment(combined?.netDeposits);

  return {
    id: String(node.id || ''),
    status: String(node.status || ''),
    account_type: mapped,
    unified_account_type: unified || null,
    nickname: node.nickname as string | null,
    currency: node.currency as string | null,
    current_balance: nlv,
    buying_power: null,
    net_deposits: nd,
    trade_custodian: tradeCustodian,
  };
}

export function accountTypeDisplay(accountType: string | null | undefined): string {
  if (!accountType) {
    return '—';
  }
  const raw = String(accountType).trim();
  const table: Record<string, string> = {
    ca_tfsa: 'TFSA',
    ca_rrsp: 'RRSP',
    ca_resp: 'RESP',
    ca_individual_resp: 'Individual RESP',
    ca_family_resp: 'Family RESP',
    ca_fhsa: 'FHSA',
    ca_joint: 'Joint',
    ca_non_registered: 'Non-registered',
    ca_rrif: 'RRIF',
    ca_lira: 'LIRA',
    ca_lrsp: 'LRSP',
  };
  return table[raw] || raw.replace('ca_', '').replace(/_/g, ' ').toUpperCase();
}

export async function listAccounts(
  accessToken: string,
  options: { oauthBundle?: OAuthBundle } = {}
): Promise<Account[]> {
  const { oauthBundle } = options;
  const iid = identityIdForGraphQL(accessToken, oauthBundle);
  if (!iid) {
    throw new Error(
      'Could not resolve identity id for account list (JWT sub / identity_canonical_id missing).'
    );
  }

  const rows: Account[] = [];
  let cursor: string | null = null;

  while (true) {
    const { status, body: pl, raw } = await graphqlRequest({
      accessToken,
      operationName: 'FetchTradeAccountList',
      query: FETCH_TRADE_ACCOUNT_LIST,
      variables: { identityId: iid, pageSize: 50, cursor },
      oauthBundle,
    });

    if (status === 401) {
      throw new Error(`accounts GraphQL HTTP ${status}`);
    }

    if (!pl || typeof pl !== 'object') {
      throw new Error(`accounts GraphQL invalid response: ${raw || pl}`);
    }

    const errs = pl.errors;
    if (Array.isArray(errs) && errs.length > 0) {
      throw new Error(`accounts GraphQL errors: ${JSON.stringify(errs)}`);
    }

    const data = pl.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') {
      throw new Error(`accounts GraphQL missing data: ${JSON.stringify(pl)}`);
    }

    const identity = data.identity as Record<string, unknown> | undefined;
    if (!identity || typeof identity !== 'object') {
      throw new Error(`accounts GraphQL missing identity: ${JSON.stringify(data)}`);
    }

    const acctConn = identity.accounts as Record<string, unknown> | undefined;
    if (!acctConn || typeof acctConn !== 'object') {
      throw new Error(`accounts GraphQL missing accounts: ${JSON.stringify(identity)}`);
    }

    const edges = acctConn.edges as unknown[];
    if (!Array.isArray(edges)) {
      throw new Error(`accounts GraphQL missing edges: ${JSON.stringify(acctConn)}`);
    }

    for (const edge of edges) {
      if (typeof edge !== 'object' || edge === null) {
        continue;
      }
      const node = (edge as Record<string, unknown>).node as Record<string, unknown> | undefined;
      if (!node || typeof node !== 'object') {
        continue;
      }
      if (String(node.status || '').toLowerCase() !== 'open') {
        continue;
      }
      rows.push(graphqlAccountToRow(node));
    }

    const page = acctConn.pageInfo as Record<string, unknown> | undefined;
    if (!page || typeof page !== 'object' || !page.hasNextPage) {
      break;
    }

    const endCursor = page.endCursor;
    if (!endCursor || typeof endCursor !== 'string') {
      break;
    }
    cursor = endCursor;
  }

  return rows;
}

export async function listPositions(
  accessToken: string,
  accountId: string,
  options: { oauthBundle?: OAuthBundle } = {}
): Promise<Position[]> {
  const aid = encodeURIComponent(String(accountId).trim());
  const { status, body } = await tradeServiceRequest('GET', `/account/positions?account_id=${aid}`, {
    accessToken,
  });

  if (status === 200 && typeof body === 'object' && body !== null && 'results' in body) {
    const results = (body as { results: unknown[] }).results;
    if (Array.isArray(results) && results.length > 0) {
      return results.filter((r): r is Position => typeof r === 'object' && r !== null);
    }
  }

  // Fallback to all positions
  const { status: status2, body: body2 } = await tradeServiceRequest('GET', '/account/positions', {
    accessToken,
  });

  if (status2 !== 200 || typeof body2 !== 'object' || body2 === null || !('results' in body2)) {
    throw new Error(`positions HTTP ${status} / ${status2}: ${JSON.stringify(body)} / ${JSON.stringify(body2)}`);
  }

  const results2 = (body2 as { results: unknown[] }).results;
  if (!Array.isArray(results2)) {
    throw new Error(`positions missing results: ${JSON.stringify(body2)}`);
  }

  const needle = String(accountId).trim();
  return results2.filter(
    (r): r is Position => typeof r === 'object' && r !== null && String((r as Record<string, unknown>).account_id || '') === needle
  );
}

function accountTypesForFilter(userType: string): string[] {
  const u = userType.trim().toLowerCase().replace(/-/g, '_');
  if (!u) {
    throw new Error('empty account type');
  }
  if (u in ACCOUNT_TYPE_ALIASES) {
    return ACCOUNT_TYPE_ALIASES[u]!;
  }
  if (u.startsWith('ca_')) {
    return [u];
  }
  return [`ca_${u}`];
}

function isTradeOrderableAccount(row: Account): boolean {
  if (typeof row !== 'object' || row === null) {
    return false;
  }
  const unified = String(row.unified_account_type || '').trim().toUpperCase();
  if (unified === 'CASH') {
    return false;
  }
  if (row.trade_custodian) {
    return true;
  }
  return !!String(row.account_type || '').trim();
}

export interface PickTradeAccountOptions {
  explicitAccountId?: string | null;
  accountType?: string | null;
  accountIndex?: number | null;
  requireTradeOrderable?: boolean;
}

export async function pickTradeAccountId(
  accessToken: string,
  options: PickTradeAccountOptions & { oauthBundle?: OAuthBundle } = {}
): Promise<string> {
  const {
    explicitAccountId,
    accountType,
    accountIndex,
    requireTradeOrderable = false,
    oauthBundle,
  } = options;

  const rows = await listAccounts(accessToken, { oauthBundle });

  if (explicitAccountId && String(explicitAccountId).trim()) {
    const aid = String(explicitAccountId).trim();
    const row = rows.find((r) => r.id === aid);
    if (!row) {
      throw new Error(
        `No Trade account with id ${JSON.stringify(aid)}. Run: wsli accounts — ids come from that list.`
      );
    }
    if (requireTradeOrderable && !isTradeOrderableAccount(row)) {
      throw new Error(
        `Account ${JSON.stringify(aid)} is not orderable for stock/ETF trades in this flow ` +
        `(its custodian branch is not WS/TR). Choose a self-directed brokerage account ` +
        `from \`wsli accounts\` (for example TFSA/RRSP/non-registered).`
      );
    }
    return aid;
  }

  if (accountType && String(accountType).trim()) {
    const rawSelector = String(accountType).trim();
    const exactIdMatch = rows.find((r) => r.id === rawSelector);
    if (exactIdMatch) {
      if (!exactIdMatch.id) {
        throw new Error('Matched account missing id');
      }
      return exactIdMatch.id;
    }

    const acceptable = accountTypesForFilter(String(accountType));
    let matches = rows.filter((r) => r.account_type && acceptable.includes(r.account_type));

    if (requireTradeOrderable) {
      matches = matches.filter((r) => isTradeOrderableAccount(r));
    }

    if (accountIndex !== null && accountIndex !== undefined) {
      const idx = Number(accountIndex);
      if (idx < 1) {
        throw new Error('--account-index must be >= 1');
      }
      if (idx > matches.length) {
        throw new Error(
          `--account-index ${idx} is out of range for type ${JSON.stringify(accountType)}; ` +
          `found ${matches.length} match(es).`
        );
      }
      const rid = matches[idx - 1]?.id;
      if (!rid) {
        throw new Error('Matched account missing id');
      }
      return rid;
    }

    if (matches.length !== 1) {
      const found = rows.map((r) => [r.id, r.account_type]);
      throw new Error(
        `Expected exactly one account for type ${JSON.stringify(accountType)} ` +
        `(matches ${JSON.stringify(acceptable)}); found ${matches.length}. Accounts: ${JSON.stringify(found)}. ` +
        'Use --account-id from `wsli accounts` or pass --account-index N.'
      );
    }

    const rid = matches[0]?.id;
    if (!rid) {
      throw new Error('Matched account missing id');
    }
    return rid;
  }

  if (rows.length === 1) {
    const r0 = rows[0];
    const rid = r0?.id;
    if (!rid) {
      throw new Error('Account list entry missing id');
    }
    if (requireTradeOrderable && !isTradeOrderableAccount(r0)) {
      throw new Error(
        'Only one account is available and it is not orderable for stock/ETF trades in this flow ' +
        '(custodian branch is not WS/TR). Use a self-directed brokerage account id.'
      );
    }
    if (r0.account_type || r0.trade_custodian) {
      return rid;
    }
    throw new Error(
      'Only one open account was returned and it does not look like a Trade brokerage account ' +
      "(no mapped type and no WS/TR custodian). Use --account-id with a self-directed account id."
    );
  }

  if (accountIndex !== null && accountIndex !== undefined) {
    const idx = Number(accountIndex);
    if (idx < 1) {
      throw new Error('--account-index must be >= 1');
    }
    if (idx > rows.length) {
      throw new Error(`--account-index ${idx} is out of range; found ${rows.length} account(s).`);
    }
    const rid = rows[idx - 1]?.id;
    if (!rid) {
      throw new Error('Selected account missing id');
    }
    return rid;
  }

  const preview = rows.map((r) => [r.id, r.account_type]);
  throw new Error(
    'You have multiple Trade accounts — choose one:\n' +
    '  wsli accounts\n' +
    'Then pass  --account-id <id>  or  --account-type tfsa|rrsp|resp|… [--account-index N]  ' +
    `(accounts: ${JSON.stringify(preview)})`
  );
}

export async function getSecurity(
  accessToken: string,
  securityId: string
): Promise<Record<string, unknown>> {
  const sid = securityId.trim();
  const { status, body } = await tradeServiceRequest('GET', `/securities/${sid}`, { accessToken });

  if (status === 404) {
    // Fallback to GraphQL quotes
    const { status: gqlStatus, body: gqlBody } = await graphqlRequest({
      accessToken,
      operationName: 'FetchIntraDayChartQuotes',
      query: FETCH_SECURITY_QUOTES,
      variables: {
        id: sid,
        date: null,
        tradingSession: 'OVERNIGHT',
        currency: null,
        period: 'ONE_DAY',
      },
    });

    if (gqlStatus === 200 && gqlBody && typeof gqlBody === 'object') {
      const data = gqlBody.data as Record<string, unknown> | undefined;
      const securityData = data?.security as Record<string, unknown> | undefined;
      if (securityData) {
        const bars = (securityData.chartBarQuotes || []) as Record<string, unknown>[];
        let price: number | undefined;
        for (const b of [...bars].reverse()) {
          const p = b.price;
          if (p !== undefined && p !== null) {
            try {
              price = Number(p);
              break;
            } catch {
              // continue
            }
          }
        }
        return {
          stock: { symbol: null },
          quote: price !== undefined ? { amount: price } : {},
        };
      }
    }
    return { stock: { symbol: null }, quote: {} };
  }

  if (status !== 200) {
    throw new Error(`securities/${sid.slice(0, 16)}… HTTP ${status}: ${JSON.stringify(body)}`);
  }

  if (typeof body !== 'object' || body === null) {
    throw new Error(`Unexpected security response: ${JSON.stringify(body)}`);
  }

  return body as Record<string, unknown>;
}

interface CreateOrderInput {
  canonicalAccountId: string;
  externalId: string;
  executionType: 'REGULAR' | 'FRACTIONAL';
  orderType: 'BUY_QUANTITY' | 'BUY_VALUE' | 'SELL_QUANTITY';
  securityId: string;
  timeInForce?: 'DAY' | null;
  quantity?: number;
  value?: number;
  limitPrice?: number;
}

export async function placeMarketBuy(
  accessToken: string,
  options: {
    accountId: string;
    securityId: string;
    quantity?: number;
    value?: number;
    limitPrice?: number;
    finalizeTimeoutSeconds?: number;
  }
): Promise<Order> {
  const { accountId, securityId, quantity, value, limitPrice, finalizeTimeoutSeconds = 30 } = options;

  if (quantity !== undefined && quantity <= 0) {
    throw new Error('quantity must be positive');
  }
  if (value !== undefined && value <= 0) {
    throw new Error('value must be positive');
  }
  if (limitPrice !== undefined && limitPrice <= 0) {
    throw new Error('limit_price must be positive');
  }

  // Limit orders require whole shares
  if (limitPrice !== undefined) {
    if (quantity === undefined || quantity % 1 !== 0) {
      throw new Error('Limit orders require whole shares only (quantity must be an integer)');
    }
    if (value !== undefined) {
      throw new Error('Limit orders cannot use dollar value (use --shares instead of --dollars)');
    }
  }

  const aid = accountId.trim();
  const sid = securityId.trim();
  if (!aid || !sid) {
    throw new Error('account_id and security_id are required');
  }

  const externalId = `order-${crypto.randomUUID()}`;

  // Determine execution type and order type
  let executionType: 'REGULAR' | 'FRACTIONAL';
  let orderType: 'BUY_QUANTITY' | 'BUY_VALUE';
  let payloadAmount: number | undefined;

  if (limitPrice !== undefined) {
    // Limit order: whole shares only
    executionType = 'REGULAR';
    orderType = 'BUY_QUANTITY';
  } else if (quantity !== undefined && quantity % 1 === 0) {
    // Whole share market order
    executionType = 'REGULAR';
    orderType = 'BUY_QUANTITY';
  } else {
    // Fractional market order (BUY_VALUE)
    executionType = 'FRACTIONAL';
    orderType = 'BUY_VALUE';

    // Fetch current price for fractional orders
    const { status: stQ, body: plQ, raw: rawQ } = await graphqlRequest({
      accessToken,
      operationName: 'FetchIntraDayChartQuotes',
      query: FETCH_SECURITY_QUOTES,
      variables: {
        id: sid,
        date: null,
        tradingSession: 'OVERNIGHT',
        currency: null,
        period: 'ONE_DAY',
      },
    });

    if (stQ !== 200 || !plQ) {
      throw new Error(`FetchIntraDayChartQuotes HTTP ${stQ}: ${rawQ || plQ}`);
    }

    if (plQ.errors) {
      throw new Error(`FetchIntraDayChartQuotes errors: ${JSON.stringify(plQ.errors)}`);
    }

    const data = plQ.data as Record<string, unknown> | undefined;
    const security = data?.security as Record<string, unknown> | undefined;
    const bars = (security?.chartBarQuotes || []) as Record<string, unknown>[];
    const prices: number[] = [];

    for (const b of bars) {
      if (typeof b === 'object' && b !== null) {
        const p = b.price;
        if (p !== undefined && p !== null) {
          try {
            prices.push(Number(p));
          } catch {
            // skip
          }
        }
      }
    }

    if (prices.length === 0) {
      throw new Error('No market price available for fractional BUY_VALUE conversion.');
    }

    const qtyForCalc = quantity !== undefined ? quantity : value !== undefined ? value : 0;
    payloadAmount = Math.round(Math.max(Number(qtyForCalc) * prices[prices.length - 1]!, 0.01) * 100) / 100;

    if (payloadAmount <= 0) {
      throw new Error('Computed fractional order value is not positive.');
    }
  }

  const inputPayload: CreateOrderInput = {
    canonicalAccountId: aid,
    externalId: externalId,
    executionType: executionType,
    orderType: orderType,
    securityId: sid,
    timeInForce: executionType === 'FRACTIONAL' ? null : 'DAY',
  };

  if (limitPrice !== undefined) {
    inputPayload.limitPrice = Number(limitPrice);
    inputPayload.quantity = Number(quantity);
  } else if (orderType === 'BUY_VALUE') {
    inputPayload.value = payloadAmount;
  } else {
    // Market order with whole shares
    inputPayload.quantity = Number(quantity);
  }

  const { status, body: pl, raw } = await graphqlRequest({
    accessToken,
    operationName: 'SoOrdersOrderCreate',
    query: MUTATION_SO_ORDERS_ORDER_CREATE,
    variables: { input: inputPayload },
  });

  if (status !== 200 || !pl) {
    throw new Error(`SoOrdersOrderCreate HTTP ${status}: ${raw || pl}`);
  }

  if (pl.errors) {
    throw new Error(`SoOrdersOrderCreate errors: ${JSON.stringify(pl.errors)}`);
  }

  const data = pl.data as Record<string, unknown> | undefined;
  const block = data?.soOrdersCreateOrder as Record<string, unknown> | undefined;

  if (!block || typeof block !== 'object') {
    throw new Error(`SoOrdersOrderCreate missing response block: ${JSON.stringify(pl)}`);
  }

  const createErrors = block.errors as unknown[];
  if (Array.isArray(createErrors) && createErrors.length > 0) {
    throw new Error(`SoOrdersOrderCreate rejected: ${JSON.stringify(createErrors)}`);
  }

  // Poll for finalization
  const deadline = Date.now() + finalizeTimeoutSeconds * 1000;
  let last: Order | undefined;

  while (Date.now() < deadline) {
    const { status: status2, body: pl2, raw: raw2 } = await graphqlRequest({
      accessToken,
      operationName: 'FetchSoOrdersExtendedOrder',
      query: FETCH_SO_ORDERS_EXTENDED_ORDER,
      variables: { branchId: 'TR', externalId: externalId },
    });

    if (status2 !== 200 || !pl2) {
      throw new Error(`FetchSoOrdersExtendedOrder HTTP ${status2}: ${raw2 || pl2}`);
    }

    if (pl2.errors) {
      throw new Error(`FetchSoOrdersExtendedOrder errors: ${JSON.stringify(pl2.errors)}`);
    }

    const data2 = pl2.data as Record<string, unknown> | undefined;
    const order = data2?.soOrdersExtendedOrder as Order | undefined;

    if (order && typeof order === 'object') {
      last = order;
      const status = String(order.status || '').toLowerCase().trim();
      if (status && !TRANSIENT_ORDER_STATUSES.has(status)) {
        return order;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(
    `Order ${externalId} did not finalize within ${finalizeTimeoutSeconds}s (last status: ${JSON.stringify(last)})`
  );
}

export async function placeMarketSell(
  accessToken: string,
  options: {
    accountId: string;
    securityId: string;
    quantity: number;
    limitPrice?: number;
    finalizeTimeoutSeconds?: number;
  }
): Promise<Order> {
  const { accountId, securityId, quantity, limitPrice, finalizeTimeoutSeconds = 30 } = options;

  if (quantity <= 0) {
    throw new Error('quantity must be positive');
  }
  if (limitPrice !== undefined && limitPrice <= 0) {
    throw new Error('limit_price must be positive');
  }

  const aid = accountId.trim();
  const sid = securityId.trim();
  if (!aid || !sid) {
    throw new Error('account_id and security_id are required');
  }

  const externalId = `order-${crypto.randomUUID()}`;

  // Determine execution type based on quantity
  const isFractional = quantity % 1 !== 0;
  const executionType: 'REGULAR' | 'FRACTIONAL' = isFractional ? 'FRACTIONAL' : 'REGULAR';

  // Build GraphQL mutation payload for sell
  const inputPayload: CreateOrderInput = {
    canonicalAccountId: aid,
    externalId: externalId,
    executionType: executionType,
    orderType: 'SELL_QUANTITY',
    quantity: Number(quantity),
    securityId: sid,
  };

  if (executionType === 'REGULAR') {
    inputPayload.timeInForce = 'DAY';
  }

  if (limitPrice !== undefined) {
    inputPayload.limitPrice = Number(limitPrice);
  }

  const { status, body: pl, raw } = await graphqlRequest({
    accessToken,
    operationName: 'SoOrdersOrderCreate',
    query: MUTATION_SO_ORDERS_ORDER_CREATE,
    variables: { input: inputPayload },
  });

  if (status !== 200 || !pl) {
    throw new Error(`SoOrdersOrderCreate HTTP ${status}: ${raw || pl}`);
  }

  if (pl.errors) {
    throw new Error(`SoOrdersOrderCreate errors: ${JSON.stringify(pl.errors)}`);
  }

  const data = pl.data as Record<string, unknown> | undefined;
  const block = data?.soOrdersCreateOrder as Record<string, unknown> | undefined;

  if (!block || typeof block !== 'object') {
    throw new Error(`SoOrdersOrderCreate missing response block: ${JSON.stringify(pl)}`);
  }

  const createErrors = block.errors as unknown[];
  if (Array.isArray(createErrors) && createErrors.length > 0) {
    throw new Error(`SoOrdersOrderCreate rejected: ${JSON.stringify(createErrors)}`);
  }

  // Poll for finalization
  const deadline = Date.now() + finalizeTimeoutSeconds * 1000;
  let last: Order | undefined;

  while (Date.now() < deadline) {
    const { status: status2, body: pl2, raw: raw2 } = await graphqlRequest({
      accessToken,
      operationName: 'FetchSoOrdersExtendedOrder',
      query: FETCH_SO_ORDERS_EXTENDED_ORDER,
      variables: { branchId: 'TR', externalId: externalId },
    });

    if (status2 !== 200 || !pl2) {
      throw new Error(`FetchSoOrdersExtendedOrder HTTP ${status2}: ${raw2 || pl2}`);
    }

    if (pl2.errors) {
      throw new Error(`FetchSoOrdersExtendedOrder errors: ${JSON.stringify(pl2.errors)}`);
    }

    const data2 = pl2.data as Record<string, unknown> | undefined;
    const order = data2?.soOrdersExtendedOrder as Order | undefined;

    if (order && typeof order === 'object') {
      last = order;
      const status = String(order.status || '').toLowerCase().trim();
      if (status && !TRANSIENT_ORDER_STATUSES.has(status)) {
        return order;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(
    `Order ${externalId} did not finalize within ${finalizeTimeoutSeconds}s (last status: ${JSON.stringify(last)})`
  );
}

export function formatMoney(m: unknown): string {
  if (typeof m !== 'object' || m === null) {
    return '—';
  }
  const amt = (m as Record<string, unknown>).amount;
  const cur = (m as Record<string, unknown>).currency || '';
  if (amt === undefined || amt === null) {
    return '—';
  }
  try {
    const numAmt = Number(amt);
    return `${numAmt.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 })} ${String(cur)}`.trim();
  } catch {
    return `${amt} ${String(cur)}`.trim();
  }
}

import { Buffer } from 'buffer';

const GRAPHQL_URL = 'https://my.wealthsimple.com/graphql';
const DEFAULT_API_VERSION = '12';

export interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string; path?: string[] }>;
}

export interface GraphQLRequestOptions {
  accessToken: string;
  operationName: string;
  query: string;
  variables?: Record<string, unknown>;
  profile?: string;
  oauthBundle?: OAuthBundle;
  timeoutSeconds?: number;
}

export interface OAuthBundle {
  access_token: string;
  refresh_token?: string;
  client_id?: string;
  identity_canonical_id?: string;
  identity_id?: string;
}

export function identityIdFromToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  const payloadB64 = parts[1];
  const padLen = (4 - (payloadB64.length % 4)) % 4;
  const pad = '='.repeat(padLen);
  try {
    const raw = Buffer.from(payloadB64 + pad, 'base64url').toString('utf-8');
    const data = JSON.parse(raw);
    const sub = data.sub;
    if (sub) {
      return String(sub);
    }
    for (const key of ['identity_canonical_id', 'identity_id']) {
      const v = data[key];
      if (v) {
        return String(v);
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function identityIdForGraphQL(
  accessToken: string,
  oauthBundle?: OAuthBundle
): string | null {
  const iid = identityIdFromToken(accessToken);
  if (iid) {
    return iid;
  }
  if (!oauthBundle) {
    return null;
  }
  for (const key of ['identity_canonical_id', 'identity_id']) {
    const v = oauthBundle[key as keyof OAuthBundle];
    if (v) {
      const s = String(v).trim();
      if (s) {
        return s;
      }
    }
  }
  return null;
}

export async function graphqlRequest(
  options: GraphQLRequestOptions
): Promise<{ status: number; body: GraphQLResponse | null; raw: string | null }> {
  const {
    accessToken,
    operationName,
    query,
    variables = {},
    profile = 'trade',
    oauthBundle,
    timeoutSeconds = 30.0,
  } = options;

  const identityId = identityIdForGraphQL(accessToken, oauthBundle);

  const headers: Record<string, string> = {
    'accept': '*/*',
    'content-type': 'application/json',
    'authorization': `Bearer ${accessToken}`,
    'origin': 'https://my.wealthsimple.com',
    'referer': 'https://my.wealthsimple.com/',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-ws-api-version': DEFAULT_API_VERSION,
    'x-ws-profile': profile,
    'x-ws-operation-name': operationName,
    'x-ws-client-library': 'wsli',
  };

  if (identityId) {
    headers['x-ws-identity-id'] = identityId;
  }

  const body = JSON.stringify({
    operationName,
    query,
    variables,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const response = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const status = response.status;
    const text = await response.text();

    try {
      const jsonBody = JSON.parse(text) as GraphQLResponse;
      return { status, body: jsonBody, raw: null };
    } catch {
      return { status, body: null, raw: text };
    }
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutSeconds}s`);
    }

    // Network error or fetch failure
    if (error instanceof TypeError) {
      throw new Error(`Network error: ${error.message}`);
    }

    throw error;
  }
}

export function formatJSON(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

import { Buffer } from 'buffer';

// Public web client id shipped with my.wealthsimple.com (not a user secret).
export const DEFAULT_OAUTH_CLIENT_ID =
  '4da53ac2b03225bed1550eba8e4611e086c7b905a3855e6ed12ea08c246758fa';

const OAUTH_TOKEN_URL = 'https://api.production.wealthsimple.com/v1/oauth/v2/token';
const OAUTH_TOKEN_INFO_URL = 'https://api.production.wealthsimple.com/v1/oauth/v2/token/info';
const SESSION_INFO_URL = 'https://api.production.wealthsimple.com/api/sessions';

export interface TokenInfo {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  created_at?: number;
}

export interface SessionInfo {
  'wsstg::lastActivityTime'?: number;
  'wsstg::sessionInactivityTimeoutMinutes'?: number;
}

export class AuthRequestError extends Error {
  public readonly status?: number;
  public readonly transient: boolean;

  constructor(message: string, options: { status?: number; transient?: boolean } = {}) {
    super(message);
    this.name = 'AuthRequestError';
    this.status = options.status;
    this.transient = options.transient ?? false;
  }
}

async function authJSONRequest(
  method: string,
  url: string,
  options: {
    timeoutSeconds?: number;
    accessToken?: string;
    jsonBody?: Record<string, unknown>;
  } = {}
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const { timeoutSeconds = 20, accessToken, jsonBody } = options;

  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    origin: 'https://my.wealthsimple.com',
    'x-wealthsimple-client': '@wealthsimple/wealthsimple',
  };

  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }

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

    let payload: Record<string, unknown>;
    try {
      payload = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      payload = { _raw_preview: text.split(/\s+/).join(' ').slice(0, 320) };
    }

    if (status >= 500 || status === 0) {
      throw new AuthRequestError(`Auth endpoint failed HTTP ${status}: ${JSON.stringify(payload)}`, {
        status,
        transient: true,
      });
    }

    if (status >= 400) {
      throw new AuthRequestError(`Auth endpoint failed HTTP ${status}: ${JSON.stringify(payload)}`, {
        status,
        transient: false,
      });
    }

    return { status, payload };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof AuthRequestError) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new AuthRequestError(`Auth endpoint timeout after ${timeoutSeconds}s`, {
        transient: true,
      });
    }

    throw new AuthRequestError(`Auth endpoint network error: ${error}`, { transient: true });
  }
}

function browserLikeRefreshHeaders(options: { accessToken?: string } = {}): Record<string, string> {
  const sessionId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const appInstanceId = crypto.randomUUID();

  const headers: Record<string, string> = {
    accept: 'application/json',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    origin: 'https://my.wealthsimple.com',
    referer: 'https://my.wealthsimple.com/',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'x-wealthsimple-client': '@wealthsimple/wealthsimple',
    'x-ws-client-tier': 'core',
    'x-platform-os': 'web',
    'x-ws-profile': 'invest',
    'x-ws-api-version': '12',
    'x-app-instance-id': appInstanceId,
    'x-ws-session-id': sessionId,
    'x-ws-device-id': deviceId,
  };

  if (options.accessToken) {
    headers.authorization = `Bearer ${options.accessToken}`;
  }

  return headers;
}

export function jwtExpUnix(accessToken: string): number | null {
  const parts = accessToken.split('.');
  if (parts.length < 2) {
    return null;
  }
  const payloadB64 = parts[1];
  const padLen = (4 - (payloadB64.length % 4)) % 4;
  const pad = '='.repeat(padLen);
  try {
    const raw = Buffer.from(payloadB64 + pad, 'base64url').toString('utf-8');
    const data = JSON.parse(raw);
    const exp = data.exp;
    if (exp === null || exp === undefined) {
      return null;
    }
    if (typeof exp === 'number') {
      return exp;
    }
    const numExp = Number(exp);
    return isNaN(numExp) ? null : numExp;
  } catch {
    return null;
  }
}

export function accessTokenNeedsRefresh(accessToken: string, skewSeconds: number = 120): boolean {
  const exp = jwtExpUnix(accessToken);
  if (exp === null) {
    return false;
  }
  return Date.now() / 1000 >= exp - skewSeconds;
}

export async function refreshAccessToken(
  refreshToken: string,
  options: {
    clientId?: string;
    accessToken?: string;
    timeoutSeconds?: number;
  } = {}
): Promise<TokenInfo> {
  const rt = refreshToken.trim();
  if (!rt) {
    throw new Error('refresh_token is empty');
  }

  const {
    clientId = DEFAULT_OAUTH_CLIENT_ID,
    accessToken,
    timeoutSeconds = 30,
  } = options;

  const body = {
    grant_type: 'refresh_token',
    refresh_token: rt,
    client_id: clientId,
  };

  const headers = browserLikeRefreshHeaders({ accessToken });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const status = response.status;
    const text = await response.text();

    let out: Record<string, unknown>;
    try {
      out = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      out = { _raw_preview: text.split(/\s+/).join(' ').slice(0, 320) };
    }

    if (status !== 200) {
      throw new Error(`OAuth refresh failed HTTP ${status}: ${JSON.stringify(out)}`);
    }

    if (typeof out.access_token !== 'string') {
      throw new Error(`OAuth refresh missing access_token: ${JSON.stringify(out)}`);
    }

    return out as unknown as TokenInfo;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`OAuth refresh network error: ${error}`);
  }
}

export async function getTokenInfo(
  accessToken: string,
  options: { timeoutSeconds?: number } = {}
): Promise<Record<string, unknown>> {
  const { timeoutSeconds = 20 } = options;
  const { status, payload } = await authJSONRequest('GET', OAUTH_TOKEN_INFO_URL, {
    timeoutSeconds,
    accessToken: accessToken.trim(),
  });

  if (status !== 200) {
    throw new AuthRequestError(`Token info unexpected HTTP ${status}`, { status });
  }

  return payload;
}

export async function getSessionInfo(
  accessToken: string,
  options: { timeoutSeconds?: number } = {}
): Promise<SessionInfo> {
  const { timeoutSeconds = 20 } = options;
  const { status, payload } = await authJSONRequest('GET', SESSION_INFO_URL, {
    timeoutSeconds,
    accessToken: accessToken.trim(),
  });

  if (status !== 200) {
    throw new AuthRequestError(`Session info unexpected HTTP ${status}`, { status });
  }

  return payload as SessionInfo;
}

export function jitterDelay(baseSeconds: number): number {
  const jitter = baseSeconds * 0.25;
  const maxJitter = Math.min(jitter, 1.0);
  const randomJitter = Math.random() * maxJitter;
  return Math.max(0, baseSeconds + randomJitter);
}

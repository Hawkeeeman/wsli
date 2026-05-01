import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_OAUTH_CLIENT_ID, accessTokenNeedsRefresh, refreshAccessToken, TokenInfo } from './oauth.js';
import { OAuthBundle } from './client.js';

export interface CredentialSource {
  bundle: OAuthBundle;
  persistPath: string | null;
  sourceLabel: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'wsli');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

export interface PersistedBundle extends OAuthBundle {
  [key: string]: unknown;
}

function mergeRefreshResponse(bundle: OAuthBundle, newToken: TokenInfo): OAuthBundle {
  const out: OAuthBundle = { ...bundle };
  out.access_token = newToken.access_token;
  if (newToken.refresh_token) {
    out.refresh_token = newToken.refresh_token;
  }
  if (newToken.expires_in !== undefined) {
    (out as TokenInfo).expires_in = newToken.expires_in;
  }
  if (newToken.scope) {
    (out as TokenInfo).scope = newToken.scope;
  }
  if (newToken.token_type) {
    (out as TokenInfo).token_type = newToken.token_type;
  }
  if (newToken.created_at !== undefined) {
    (out as TokenInfo).created_at = newToken.created_at;
  }
  return out;
}

function expandHome(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return filePath.replace('~', os.homedir());
  }
  return filePath;
}

export function persistBundle(filePath: string, bundle: OAuthBundle): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // File exists but invalid JSON, start fresh
    }
  }

  for (const key of ['access_token', 'refresh_token', 'client_id']) {
    if (key in bundle && bundle[key as keyof OAuthBundle]) {
      existing[key] = bundle[key as keyof OAuthBundle];
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8');
}

function loadBundleFromFile(filePath: string): OAuthBundle | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string') {
      return parsed as OAuthBundle;
    }
    return null;
  } catch {
    return null;
  }
}

export async function ensureFreshAccessToken(
  bundle: OAuthBundle,
  options: {
    persistPath?: string | null;
    forceRefresh?: boolean;
  } = {}
): Promise<string> {
  const noRefresh = process.env.WSPROBE_NO_REFRESH?.trim() === '1' ||
    process.env.WSPROBE_NO_REFRESH?.trim() === 'true' ||
    process.env.WSPROBE_NO_REFRESH?.trim() === 'yes';

  if (noRefresh) {
    const tok = bundle.access_token;
    if (!tok) {
      throw new Error('No access_token in credential bundle');
    }
    return tok;
  }

  const access = bundle.access_token;
  if (!access) {
    throw new Error('No access_token in credential bundle');
  }

  const refresh = bundle.refresh_token?.trim() || '';
  const force = options.forceRefresh || false;

  if (!force && !accessTokenNeedsRefresh(access)) {
    return access;
  }

  if (!refresh) {
    throw new Error(
      'Access token is expired or near expiry and no refresh_token is available. ' +
      'Run wsli setup again, or add refresh_token to your token file / ' +
      'set WEALTHSIMPLE_REFRESH_TOKEN.'
    );
  }

  let clientId = bundle.client_id?.trim() || DEFAULT_OAUTH_CLIENT_ID;
  const envClientId = process.env.WEALTHSIMPLE_OAUTH_CLIENT_ID?.trim();
  if (envClientId) {
    clientId = envClientId;
  }

  try {
    const newToken = await refreshAccessToken(refresh, {
      clientId,
      accessToken: access,
    });

    const merged = mergeRefreshResponse(bundle, newToken);
    if (options.persistPath) {
      persistBundle(options.persistPath, merged);
    }

    const newAccess = merged.access_token;
    if (!newAccess) {
      throw new Error('Refresh succeeded but no access_token in merged bundle');
    }
    return newAccess;
  } catch (error) {
    throw new Error(
      'Access token expired and refresh failed. ' +
      'Log in at https://my.wealthsimple.com again (or set fresh ' +
      'WEALTHSIMPLE_ACCESS_TOKEN / refresh_token in config). ' +
      `Detail: ${error}`
    );
  }
}

export function loadOAuthBundle(options: {
  accessToken?: string;
  refreshToken?: string;
  tokenFile?: string;
}): CredentialSource {
  const { accessToken: injected, refreshToken: cliRefresh, tokenFile } = options;

  if (injected) {
    const bundle: OAuthBundle = { access_token: String(injected) };
    const refresh = cliRefresh || process.env.WEALTHSIMPLE_REFRESH_TOKEN?.trim();
    if (refresh) {
      bundle.refresh_token = refresh;
    }
    const clientId = process.env.WEALTHSIMPLE_OAUTH_CLIENT_ID?.trim();
    if (clientId) {
      bundle.client_id = clientId;
    }
    return { bundle, persistPath: null, sourceLabel: 'injected' };
  }

  if (tokenFile) {
    const p = expandHome(tokenFile);
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as OAuthBundle;
    if (typeof data !== 'object' || data === null || !data.access_token) {
      throw new Error(`No access_token in ${p}`);
    }
    return { bundle: data, persistPath: p, sourceLabel: `file:${p}` };
  }

  const oauthJson = process.env.WEALTHSIMPLE_OAUTH_JSON?.trim();
  if (oauthJson) {
    try {
      const data = JSON.parse(oauthJson) as OAuthBundle;
      if (typeof data !== 'object' || data === null || !data.access_token) {
        throw new Error('WEALTHSIMPLE_OAUTH_JSON must be a JSON object with access_token');
      }
      return { bundle: data, persistPath: null, sourceLabel: 'env:oauth_json' };
    } catch (error) {
      throw new Error(`WEALTHSIMPLE_OAUTH_JSON must be valid JSON: ${error}`);
    }
  }

  const envToken = process.env.WEALTHSIMPLE_ACCESS_TOKEN?.trim();
  if (envToken) {
    const bundle: OAuthBundle = { access_token: envToken };
    const refresh = process.env.WEALTHSIMPLE_REFRESH_TOKEN?.trim();
    if (refresh) {
      bundle.refresh_token = refresh;
    }
    const clientId = process.env.WEALTHSIMPLE_OAUTH_CLIENT_ID?.trim();
    if (clientId) {
      bundle.client_id = clientId;
    }
    return { bundle, persistPath: null, sourceLabel: 'env' };
  }

  if (fs.existsSync(CONFIG_FILE)) {
    const data = loadBundleFromFile(CONFIG_FILE);
    if (data) {
      return { bundle: data, persistPath: CONFIG_FILE, sourceLabel: `config:${CONFIG_FILE}` };
    }
  }

  const session = loadBundleFromFile(SESSION_FILE);
  if (session) {
    return { bundle: session, persistPath: SESSION_FILE, sourceLabel: `session:${SESSION_FILE}` };
  }

  throw new Error(
    'No credentials found.\n' +
    'Run setup once:\n' +
    '  wsli setup\n' +
    'Or paste JSON into wsli import-session (see wsli session-path for file location)\n' +
    'Or set WEALTHSIMPLE_OAUTH_JSON (JSON with access_token + optional refresh_token), ' +
    'or WEALTHSIMPLE_ACCESS_TOKEN / WEALTHSIMPLE_REFRESH_TOKEN / --token-file / ' +
    CONFIG_FILE
  );
}

export async function resolveAccessToken(options: {
  accessToken?: string;
  refreshToken?: string;
  tokenFile?: string;
}): Promise<string> {
  const { bundle, persistPath } = loadOAuthBundle(options);
  return ensureFreshAccessToken(bundle, { persistPath });
}

export async function resolveAccessTokenForceRefresh(options: {
  accessToken?: string;
  refreshToken?: string;
  tokenFile?: string;
}): Promise<string> {
  const { bundle, persistPath } = loadOAuthBundle(options);
  return ensureFreshAccessToken(bundle, { persistPath, forceRefresh: true });
}

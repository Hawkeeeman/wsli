import { createHash } from 'crypto';
import { OAuthBundle } from './client.js';

export function tokenFingerprint(token: string | null | undefined): string | null {
  const tok = String(token || '').trim();
  if (!tok) {
    return null;
  }
  return createHash('sha256').update(tok).digest('hex').slice(0, 12);
}

export function maskSecretValue(value: string): string {
  const s = value.trim();
  if (!s) {
    return s;
  }
  if (s.length <= 8) {
    return '*'.repeat(s.length);
  }
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

export function sanitizeForLog(value: unknown, keyHint?: string): unknown {
  const key = (keyHint || '').toLowerCase();
  const secretKeys = ['token', 'authorization', 'cookie', 'secret', 'password', 'api_key', 'apikey'];
  const secretKey = secretKeys.some((sk) => key.includes(sk));

  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.map((v) => sanitizeForLog(v, keyHint));
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = sanitizeForLog(v, k);
    }
    return result;
  }

  if (value === null) {
    return null;
  }

  if (secretKey && typeof value === 'string') {
    return maskSecretValue(value);
  }

  return value;
}

export function isoToUnix(value: string): number | null {
  const text = (value || '').trim();
  if (!text) {
    return null;
  }
  try {
    const date = new Date(text);
    if (isNaN(date.getTime())) {
      return null;
    }
    return date.getTime() / 1000;
  } catch {
    return null;
  }
}

export function parseSinceSeconds(value: string): number | null {
  const text = (value || '').trim().toLowerCase();
  if (!text) {
    return null;
  }

  const match = text.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error('--since must look like 30m, 2h, 1d, or 45s');
  }

  const qty = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

  return qty * mult[unit]!;
}

export function normalizeSecurityId(raw: string): string {
  const val = (raw || '').trim();
  if (!val) {
    throw new Error('security_id is required (expected format: sec-s-...)');
  }

  if (val.includes('sec-s-') && !val.startsWith('sec-s-')) {
    const start = val.indexOf('sec-s-');
    let end = val.length;
    for (const sep of ['?', '&', '#', '/', ' ']) {
      const idx = val.indexOf(sep, start);
      if (idx !== -1 && idx < end) {
        end = idx;
      }
    }
    return val.slice(start, end);
  }

  if (!val.startsWith('sec-s-')) {
    throw new Error(
      'Invalid security_id format. Expected a Wealthsimple security id like ' +
      "'sec-s-...'. Use `wsli lookup <ticker>` to find it."
    );
  }

  return val;
}

export function bundleFromPastedText(raw: string): OAuthBundle {
  const text = (raw || '').trim();
  if (!text) {
    throw new Error('No input received.');
  }

  const candidates: string[] = [text];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0) {
    candidates.push(lines[lines.length - 1]!);
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }

  for (const cand of candidates) {
    const c = cand.trim();
    if (!c) {
      continue;
    }

    for (const payload of [c, decodeURIComponent(c)]) {
      try {
        const data = JSON.parse(payload) as OAuthBundle;
        if (typeof data === 'object' && data !== null && typeof data.access_token === 'string') {
          return data;
        }
      } catch {
        // continue
      }
    }
  }

  throw new Error('Could not parse credentials JSON. Paste the console output JSON object.');
}

export { formatJSON } from './client.js';

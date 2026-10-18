/**
 * Keeps the raw session token out of the bodies identity answers with.
 *
 * Better Auth's `GET /api/auth/get-session` and `GET /api/auth/list-sessions` return each session WITH its `token` in the JSON body.
 * The cookie that carries that token is `HttpOnly`, so script cannot read it; the body is not, so one XSS in the SPA could read
 * `/api/auth/get-session` and walk away with a value a session lookup accepts. Nothing in the SPA reads the field (it asks
 * `/v1/auth/me` who it is), so the API removes it from those two responses: `onSend`, on the way out.
 *
 * Only the session shape is touched (`token` next to `userId` and `expiresAt`), so another `token` field is left alone.
 */
const REDACTED_PATHS = new Set(['/api/auth/get-session', '/api/auth/list-sessions']);

export function isSessionBody(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return REDACTED_PATHS.has(path.replace(/\/+$/, ''));
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const isSession = 'token' in record && 'userId' in record && 'expiresAt' in record;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(record)) {
    if (isSession && key === 'token') continue;
    out[key] = strip(inner);
  }
  return out;
}

/** The response body without session tokens; anything that is not a JSON string or buffer is returned as it came. */
export function redactSessionTokens(payload: unknown): unknown {
  const text =
    typeof payload === 'string'
      ? payload
      : Buffer.isBuffer(payload)
        ? payload.toString('utf8')
        : undefined;
  if (text === undefined || !text.includes('"token"')) return payload;
  try {
    return JSON.stringify(strip(JSON.parse(text)));
  } catch {
    return payload;
  }
}

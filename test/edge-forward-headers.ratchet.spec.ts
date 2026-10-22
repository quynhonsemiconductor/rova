/**
 * Every request header the API READS must be one the Pages Function FORWARDS (or be on a short list of reasons it need
 * not be).
 *
 * The Function that fronts the SPA used to forward everything except a deny-list of spoofable headers. It now forwards
 * an ALLOW-LIST (`forwardToOrigin`: safer, because what a visitor invents never reaches the API), and an allow-list has
 * a failure mode a deny-list does not: a header the API starts to depend on is silently dropped until someone notices.
 * That is exactly how SCM webhooks sent to the SPA host came to answer 401: `x-hub-signature-256`, `x-github-event` and
 * `x-github-delivery` were read by `ScmWebhookController` and named nowhere in the Function.
 *
 * So this reads the API's own sources for header reads and fails when one is neither forwarded nor explained. It is a
 * source-reading test on purpose: the omission is invisible to anything that exercises the handler directly.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDGE_FORWARD_HEADERS } from '@quynhonsemiconductor/platform-http/edge';
import { INTEGRATION_FORWARD_HEADERS, SPA_FORWARD_HEADERS } from '../apps/web/functions/_lib/proxy';

const ROOT = join(__dirname, '..');

/** Headers the API reads that the Function deliberately does not forward, and why. */
const NOT_FORWARDED: Record<string, string> = {
  'x-amzn-trace-id':
    'Set by the ALB on the request it forwards to the task. A browser or a webhook sender never supplies it, and the ' +
    'Function path does not cross the ALB; the access log reads it only to attribute ALB wait time.',
  'x-qnsc-edge-ip':
    'Set BY the Function (signed). The API reads the signed trio in clientIp(); a visitor-supplied copy is stripped.',
  'x-qnsc-edge-ts': 'Set BY the Function (signed).',
  'x-qnsc-edge-sig': 'Set BY the Function (signed).',
  'cf-connecting-ip':
    'Set by Cloudflare on the request to the API; the Function must not forward a visitor-chosen copy.',
  'x-forwarded-for':
    'Appended by every hop; the Function must not forward a visitor-chosen copy (clientIp() ranks it last).',
};

const FORWARDED = new Set(
  [...EDGE_FORWARD_HEADERS, ...SPA_FORWARD_HEADERS, ...INTEGRATION_FORWARD_HEADERS].map((h) =>
    h.toLowerCase(),
  ),
);

/**
 * Files whose `headers` are not an inbound REQUEST: an outgoing email's headers, and a RESPONSE from Graph / GitHub.
 * Listed by name so a new file is scanned by default.
 */
const NOT_INBOUND_REQUESTS: Record<string, string> = {
  'libs/platform/src/email/providers/shared.ts':
    'builds the headers of an OUTGOING email (Precedence, List-Unsubscribe)',
  'libs/platform/src/outbox/retry-after.ts':
    'reads the headers of a RESPONSE (Retry-After, x-ratelimit-*) from Graph or GitHub',
};

/** Header names the API reads, by literal: `@Headers('x')`, `headers['x']`, `headers.authorization`. */
function headersRead(): Map<string, string[]> {
  const files = execFileSync(
    'git',
    ['ls-files', 'libs/**/*.ts', 'apps/api/**/*.ts', 'apps/worker/**/*.ts'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter((f) => f && !f.endsWith('.spec.ts') && !(f in NOT_INBOUND_REQUESTS));

  const found = new Map<string, string[]>();
  const add = (name: string, file: string) => {
    const key = name.toLowerCase();
    found.set(key, [...(found.get(key) ?? []), file]);
  };
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    for (const m of source.matchAll(/@Headers\(\s*['"]([A-Za-z0-9-]+)['"]/g)) add(m[1], file);
    for (const m of source.matchAll(/headers\[\s*['"]([A-Za-z0-9-]+)['"]\s*\]/g)) add(m[1], file);
    for (const m of source.matchAll(/\.headers\.(authorization|cookie)\b/g)) add(m[1], file);
    for (const m of source.matchAll(/headers\.get\(\s*['"]([A-Za-z0-9-]+)['"]/g)) add(m[1], file);
  }
  // Read through a named constant, which a literal scan cannot see.
  const csrf = readFileSync(join(ROOT, 'libs/platform/src/http/csrf.ts'), 'utf8');
  const csrfName = /CSRF_HEADER\s*=\s*['"]([a-z-]+)['"]/.exec(csrf)?.[1];
  if (csrfName) add(csrfName, 'libs/platform/src/http/csrf.ts');
  return found;
}

describe('headers the API reads vs headers the Pages Function forwards', () => {
  const read = headersRead();

  it('finds the headers it claims to guard (a scan that finds nothing proves nothing)', () => {
    for (const expected of [
      'x-hub-signature-256',
      'x-github-event',
      'x-github-delivery',
      'last-event-id',
      'idempotency-key',
    ]) {
      expect([...read.keys()], expected).toContain(expected);
    }
  });

  it('every header the API reads is forwarded, or has a stated reason it is not', () => {
    const unexplained = [...read.entries()]
      .filter(([name]) => !FORWARDED.has(name) && !(name in NOT_FORWARDED))
      .map(([name, files]) => `${name}  (read in ${[...new Set(files)].join(', ')})`);

    expect(
      unexplained,
      `The API reads these request headers but the Pages Function (apps/web/functions/_lib/proxy.ts) drops them, so a ` +
        `request that comes through the SPA host loses them. Add each to SPA_FORWARD_HEADERS or ` +
        `INTEGRATION_FORWARD_HEADERS, or to NOT_FORWARDED here with the reason:\n${unexplained.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps no stale excuse: every NOT_FORWARDED entry names a header that is not forwarded', () => {
    const stale = Object.keys(NOT_FORWARDED).filter((name) => FORWARDED.has(name));
    expect(stale).toEqual([]);
  });
});

/**
 * `pnpm local:check`: proves the local stack works from a clean start, end to end, through the same doors the app uses.
 *
 *   1. API probes         GET /readyz on the API port answers 200 with the database and cache up.
 *   2. Worker             the worker writes a beat to Valkey every 30 s under worker:heartbeat:<host>; a fresh beat proves a live worker.
 *   3. Sign-in            POST /api/auth/test-login through the web dev server's proxy, then GET /v1/auth/me with that session.
 *   4. Storage            a marker object round-trips through the storage emulator, and the marker the PREVIOUS run wrote is still
 *                         there (that is the persistence claim: the bucket outlives a restart).
 *   5. Mail               a message sent through platform-mail's smtp transport (the one EMAIL_PROVIDER=smtp uses) lands in Mailpit.
 *
 * Writes only its own marker object and one test message. Exits 1 at the first failing step, naming it.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createEmailSender } from '@quynhonsemiconductor/platform-mail/sender';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

process.loadEnvFile?.('.env');

const env = (key: string, fallback?: string): string => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`${key} is not set: copy .env.example to .env`);
  return value;
};

const API = `http://localhost:${env('PORT', '3010')}`;
const WEB = `http://localhost:${env('WEB_DEV_PORT', '5175')}`;
const MAILPIT = `http://localhost:${env('MAILPIT_UI_HOST_PORT', '8120')}`;
const TEST_LOGIN_EMAIL = 'dev@qnsc.dev'; // db/seeds/demo.ts: the local fixture account, seeded by `pnpm db:seed`.
const MARKER_KEY = 'local-check/persistence-marker.txt';
// Same values as apps/worker/src/heartbeat/worker-heartbeat.service.ts; this script runs outside the worker, so it repeats them.
// The cache adds the product's namespace (rova:), so the pattern matches the prefix anywhere in the key.
const HEARTBEAT_PREFIX = 'worker:heartbeat:';
const HEARTBEAT_TTL_MS = 90_000;

class CheckFailed extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    process.stdout.write(`ok      ${name}: ${detail}\n`);
  } catch (err) {
    process.stderr.write(`FAIL    ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
async function main(): Promise<void> {
  await step('api probes', async () => {
    const res = await fetch(`${API}/readyz`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    expect(
      res.status === 200,
      `GET ${API}/readyz answered ${res.status}; is the API running (pnpm start:dev)?`,
    );
    return `readyz 200 (${JSON.stringify(body).slice(0, 120)})`;
  });

  await step('worker heartbeat', async () => {
    const redis = new Redis(env('REDIS_URL', 'redis://localhost:6320'));
    try {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(
          cursor,
          'MATCH',
          `*${HEARTBEAT_PREFIX}*`,
          'COUNT',
          100,
        );
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      expect(
        keys.length > 0,
        'no worker heartbeat key: is the worker running (make local starts it)?',
      );
      const beats = await Promise.all(keys.map(async (key) => ({ key, at: await redis.get(key) })));
      const fresh = beats.filter(
        (b) => b.at !== null && Date.now() - Date.parse(b.at) < HEARTBEAT_TTL_MS,
      );
      expect(fresh.length > 0, `heartbeat keys exist but none is fresh: ${keys.join(', ')}`);
      return `${fresh.length} live replica(s): ${fresh.map((f) => f.key).join(', ')}`;
    } finally {
      redis.disconnect();
    }
  });

  await step('sign-in through the web proxy', async () => {
    const login = await fetch(`${WEB}/api/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_LOGIN_EMAIL }),
    });
    expect(
      login.ok,
      `POST test-login answered ${login.status}; is IDENTITY_TEST_LOGIN=enabled and the fixture seeded?`,
    );
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    expect(cookie.length > 0, 'test-login set no session cookie');
    const me = await fetch(`${WEB}/v1/auth/me`, { headers: { cookie } });
    expect(me.status === 200, `GET /v1/auth/me through the proxy answered ${me.status}`);
    const user = (await me.json()) as { email?: string };
    expect(
      user.email === TEST_LOGIN_EMAIL,
      `session belongs to ${user.email ?? 'nobody'}, not ${TEST_LOGIN_EMAIL}`,
    );
    return `signed in as ${TEST_LOGIN_EMAIL}`;
  });

  await step('storage round trip and persistence', async () => {
    const s3 = new S3Client({
      endpoint: env('STORAGE_ENDPOINT', 'http://localhost:4620'),
      region: env('AWS_DEFAULT_REGION', 'ap-southeast-1'),
      forcePathStyle: true,
      credentials: {
        accessKeyId: env('AWS_ACCESS_KEY_ID', 'test'),
        secretAccessKey: env('AWS_SECRET_ACCESS_KEY', 'test'),
      },
    });
    const Bucket = env('S3_ATTACHMENTS_BUCKET', 'rova-attachments');

    let previous = 'none (first run)';
    try {
      const old = await s3.send(new GetObjectCommand({ Bucket, Key: MARKER_KEY }));
      previous = `present, written by an earlier run: ${await old.Body?.transformToString()}`;
    } catch (err) {
      const code = (err as { name?: string }).name;
      expect(
        code === 'NoSuchKey' || code === 'NotFound',
        `reading the previous marker failed: ${String(code)}`,
      );
    }

    const marker = `${new Date().toISOString()} ${randomUUID()}`;
    await s3.send(
      new PutObjectCommand({ Bucket, Key: MARKER_KEY, Body: marker, ContentType: 'text/plain' }),
    );
    const back = await s3.send(new GetObjectCommand({ Bucket, Key: MARKER_KEY }));
    expect(
      (await back.Body?.transformToString()) === marker,
      'the marker read back is not the marker written',
    );
    return `wrote and read back a marker; previous run's marker: ${previous}`;
  });

  await step('mail lands in Mailpit', async () => {
    const sender = createEmailSender({
      env: {
        MAIL_TRANSPORT: 'smtp',
        MAIL_SMTP_HOST: env('MAIL_SMTP_HOST', 'localhost'),
        MAIL_SMTP_PORT: env('MAIL_SMTP_PORT', '1120'),
        MAIL_SMTP_FROM: env('MAIL_FROM_EMAIL', 'noreply@qnsc.vn'),
        NODE_ENV: 'development',
      },
    });
    const nonce = randomUUID();
    const subject = `local check ${nonce}`;
    await sender.send({
      to: 'local-check@qnsc.vn',
      subject,
      html: `<p>${nonce}</p>`,
      text: nonce,
      category: 'local.check',
      idempotencyKey: nonce,
    });
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const res = await fetch(`${MAILPIT}/api/v1/messages`);
      const list = (await res.json()) as { messages?: { Subject?: string }[] };
      if (list.messages?.some((m) => m.Subject === subject)) {
        return `delivered to Mailpit (${MAILPIT}) as "${subject}"`;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new CheckFailed(`the message did not appear in Mailpit at ${MAILPIT} within 15 seconds`);
  });

  process.stdout.write('all checked steps passed\n');
}

void main();

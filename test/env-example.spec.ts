/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '@platform/config/env.schema';

/**
 * `.env.example` is the whole setup of a clean clone (`cp .env.example .env`), so it has to keep working against
 * the things it points at. Each of these was wrong, and none was visible from the file alone:
 *
 *   - the migrate step ran as `rova_migrate:changeme`, a role a fresh database does not let log in;
 *   - the API refused to boot: JWT_PRIVATE_KEY was empty and the four ENTRA_* values the schema requires in every
 *     environment were commented out;
 *   - S3_ATTACHMENTS_BUCKET named `rova-attachments` while the LocalStack hook created `rally-attachments`, so every
 *     upload failed with NoSuchBucket;
 *   - VITE_DEV_LOGIN was in a file nobody copies, so the login page had no dev login;
 *   - the sender was on `qnsc.dev`, a domain this organisation does not use for mail.
 *
 * This reads the files rather than importing the values, on purpose: what matters is that the FILES agree. The CI job
 * "local quickstart" is the end-to-end version (it boots the stack from this file); this one fails in seconds, and
 * names the variable.
 *
 * __dirname, not import.meta.dirname: this suite runs as CommonJS.
 */

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** `KEY=value` lines, as `process.loadEnvFile` reads them: no quoting in this file, split at the first `=`. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Every variable NAMED in the file, active or commented out (`# KEY=...`). */
function namedKeys(text: string): string[] {
  return [...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
}

const example = read('.env.example');
const env = parseEnv(example);
const compose = read('docker-compose.dev.yml');
const bootstrap = read('scripts/localstack/01-bootstrap.sh');
const vite = read('apps/web/vite.config.ts');

/** The host port a compose service publishes for a container port. */
function hostPort(container: string, containerPort: number): string | undefined {
  const service = new RegExp(
    `container_name: ${container}\\b[\\s\\S]*?(?=\\n  \\w[\\w-]*:\\n|\\nvolumes:|$)`,
  ).exec(compose)?.[0];
  return new RegExp(`'(\\d+):${containerPort}'`).exec(service ?? '')?.[1];
}

const portOf = (url: string | undefined) => new URL(url ?? 'http://invalid').port;

describe('.env.example boots the API and the worker', () => {
  it('is accepted by the env schema as it stands (nothing to fill in)', () => {
    const result = EnvSchema.safeParse(env);
    expect(result.success, JSON.stringify(result.success ? '' : result.error.issues)).toBe(true);
  });

  it('carries the secret identity signs its cookies with, and no JWT key', () => {
    const result = EnvSchema.safeParse(env);
    expect(result.success).toBe(true);
    expect(env['BETTER_AUTH_SECRET']?.length).toBeGreaterThanOrEqual(32);
    expect(Object.keys(env).filter((k) => k.startsWith('JWT_') || k.startsWith('BFF_'))).toEqual(
      [],
    );
    expect(Object.keys(env)).not.toContain('ENTRA_REDIRECT_URI');
  });

  it('names only variables the code knows (a typo here would be silently ignored)', () => {
    const schemaKeys = new Set(
      [
        ...read('libs/platform/src/config/env.schema.ts').matchAll(/^\s+([A-Z][A-Z0-9_]+):\s/gm),
      ].map((m) => m[1]),
    );
    // Read outside the schema: the migrator and the seeds, the Vite dev server, and platform-runtime's shutdown.
    const readElsewhere = new Set([
      'SEED_ON_DEPLOY',
      // The worker's entry point reads its own service name from process.env (apps/worker/src/worker-options.ts).
      'OTEL_WORKER_SERVICE_NAME',
      'BOOTSTRAP_WORKSPACE_NAME',
      'BOOTSTRAP_WORKSPACE_SLUG',
      'VITE_DEV_LOGIN',
      'VITE_APP_ENV',
      'SHUTDOWN_TIMEOUT_MS',
      'SHUTDOWN_ENDPOINT_DELAY_MS',
    ]);
    const unknown = namedKeys(example).filter((k) => !schemaKeys.has(k) && !readElsewhere.has(k));
    expect(unknown).toEqual([]);
  });

  it('does not carry a variable nothing reads', () => {
    // AWS_ACCOUNT_ID was declared in the schema and in this file and read by no code at all.
    expect(Object.keys(env)).not.toContain('AWS_ACCOUNT_ID');
  });
});

describe('.env.example agrees with the dev tooling', () => {
  it('serves the API on the port the Vite proxy forwards to', () => {
    const target = /process\.env\.API_TARGET \?\? 'http:\/\/localhost:(\d+)'/.exec(vite)?.[1];
    expect(target, 'no default proxy target found in apps/web/vite.config.ts').toBeDefined();
    expect(env['PORT']).toBe(target);
  });

  it('connects as a role a fresh database lets log in', () => {
    // The compose stack's only login is the superuser. The restricted roles are NOLOGIN until someone grants a password.
    expect(new URL(env['DATABASE_URL'] ?? '').username).toBe('postgres');
    expect(compose).toContain('POSTGRES_USER: postgres');
    expect(compose).toContain('POSTGRES_PASSWORD: postgres');
    expect(new URL(env['DATABASE_URL'] ?? '').password).toBe('postgres');
  });

  it('points at the host ports docker-compose.dev.yml publishes', () => {
    expect(portOf(env['DATABASE_URL'])).toBe(hostPort('rova-postgres', 5432));
    expect(portOf(env['REDIS_URL'])).toBe(hostPort('rova-valkey', 6379));
    expect(portOf(env['STORAGE_ENDPOINT'])).toBe(hostPort('rova-localstack', 4566));
    expect(portOf(env['AWS_ENDPOINT_URL'])).toBe(hostPort('rova-localstack', 4566));
    expect(portOf(env['OTEL_EXPORTER_OTLP_ENDPOINT'])).toBe(hostPort('rova-otel', 4318));
  });

  it('uses the buckets the LocalStack init hook creates and the compose healthcheck waits for', () => {
    const priv = /^PRIVATE_BUCKET="([^"]+)"/m.exec(bootstrap)?.[1];
    const pub = /^PUBLIC_BUCKET="([^"]+)"/m.exec(bootstrap)?.[1];
    expect(priv, 'PRIVATE_BUCKET not found in scripts/localstack/01-bootstrap.sh').toBeDefined();
    expect(pub, 'PUBLIC_BUCKET not found in scripts/localstack/01-bootstrap.sh').toBeDefined();
    expect(env['S3_ATTACHMENTS_BUCKET']).toBe(priv);
    expect(env['S3_PUBLIC_ASSETS_BUCKET']).toBe(pub);
    expect(compose).toContain(`--bucket ${priv}`);
    expect(compose).toContain(`--bucket ${pub}`);
  });

  it('sends uploads to LocalStack with static credentials, never to the real AWS S3', () => {
    expect(env['STORAGE_ENDPOINT'], 'unset STORAGE_ENDPOINT selects real AWS S3').toBeTruthy();
    expect(env['STORAGE_ACCESS_KEY_ID']).toBeTruthy();
    expect(env['STORAGE_SECRET_ACCESS_KEY']).toBeTruthy();
    expect(env['STORAGE_FORCE_PATH_STYLE']).toBe('true');
  });

  it('allows the browser origin the Vite server, LocalStack CORS and Playwright all use', () => {
    const port = /port:\s*(\d+)/.exec(vite)?.[1];
    expect(port, 'apps/web/vite.config.ts does not pin its port').toBeDefined();
    const origin = `http://localhost:${port}`;
    expect(vite).toContain('strictPort: true');
    expect(env['CORS_ORIGINS']).toBe(origin);
    expect(env['APP_BASE_URL']).toBe(origin);
    expect(bootstrap).toContain(`WEB_ORIGIN="${origin}"`);
    expect(read('apps/web/playwright.config.ts')).toContain(origin);
  });

  it('lets the SPA read the root .env, where the dev login switch lives', () => {
    // ...but ONLY for the dev server: a build or a unit run must not read a laptop's root .env (VITE_DEV_LOGIN=true would be
    // baked into a bundle that could be deployed).
    expect(vite).toMatch(
      /envDir:\s*command === 'serve' && mode === 'development'\s*\?\s*path\.resolve\(__dirname, '\.\.\/\.\.'\)\s*:\s*undefined/,
    );
    expect(env['VITE_DEV_LOGIN']).toBe('true');
  });
});

describe('.env.example signs a developer in with no further setup', () => {
  it('loads the demo users and allows the dev login', () => {
    expect(env['NODE_ENV']).toBe('development');
    expect(env['SEED_ON_DEPLOY'], 'db:migrate would seed no demo users').toBe('true');
  });

  it('seeds the user the README tells people to sign in as', () => {
    expect(read('db/seeds/demo.ts')).toContain("'admin@qnsc.dev'");
  });

  it('labels every log line and metric as a local run, not develop or production', () => {
    expect(env['DEPLOYMENT_ENV']).toBe('local');
  });
});

describe('.env.example holds no real secret and no foreign sender', () => {
  it.each(['COOKIE_SECRET', 'CSRF_SECRET', 'BETTER_AUTH_SECRET', 'ENTRA_CLIENT_SECRET'])(
    '%s is an obvious local placeholder',
    (key) => {
      expect(env[key]).toMatch(/^local-dev-only-/);
    },
  );

  it.each([
    'EDGE_CLIENT_IP_SECRET',
    'EDGE_CLIENT_IP_SECRET_PREVIOUS',
    'RESEND_API_KEY',
    'GITHUB_APP_PRIVATE_KEY',
  ])('%s is not set: a developer supplies their own', (key) => {
    expect(env[key]).toBeUndefined();
  });

  it('sends mail from a domain this organisation owns (and, with the dev provider, sends none)', () => {
    expect(env['EMAIL_PROVIDER']).toBe('dev');
    expect(env['MAIL_FROM_EMAIL']).toMatch(/@qnsc\.vn$/);
  });
});

describe('the README and the "local quickstart" CI job run the same commands', () => {
  // The job is only a guarantee about the README if it runs what the README says.
  const COMMANDS = [
    'cp .env.example .env',
    'docker compose -f docker-compose.dev.yml up -d --wait',
    'pnpm db:migrate',
    'pnpm start:dev',
    'pnpm start:dev:worker',
    'pnpm dev:web',
  ];
  const readme = read('README.md');
  const workflow = read('.github/workflows/web-ci.yml');

  it.each(COMMANDS)('`%s` is in both', (command) => {
    expect(readme, `README.md "Local stack" lacks: ${command}`).toContain(command);
    expect(workflow, `web-ci.yml "local quickstart" lacks: ${command}`).toContain(command);
  });
});

describe('the quickstart job gates the PR', () => {
  it('is a dependency of `Web CI required`', () => {
    expect(read('.github/workflows/web-ci.yml')).toMatch(
      /needs: \[changes, quality, test, e2e, build, quickstart\]/,
    );
  });
});

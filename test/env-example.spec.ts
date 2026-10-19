/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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
const composeDoc = parseYaml(compose, { merge: true }) as {
  services: Record<string, { ports?: unknown[] }>;
};
const bootstrap = read('scripts/localstack/01-bootstrap.sh');
const vite = read('apps/web/vite.config.ts');

/**
 * Every `ports:` entry of a compose service, as `host_ip:published:target`, parsed by a real YAML parser so the block,
 * flow and quoted forms all read the same. Short syntax stays as written (a bare `5432` stays bare). Long syntax folds its
 * keys into that shape, with an empty host_ip when none is given, so the loopback check fails on it.
 */
function portEntries(service: string): string[] {
  const ports = composeDoc.services[service]?.ports ?? [];
  return ports.map((port) => {
    if (typeof port !== 'object' || port === null) return String(port);
    const long = port as { host_ip?: unknown; published?: unknown; target?: unknown };
    const field = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
    return [field(long.host_ip), field(long.published), field(long.target)].join(':');
  });
}

/** The host port a compose service publishes for a container port, as `127.0.0.1:${VARIABLE:-default}:containerPort`. */
function publishedPort(
  service: string,
  containerPort: number,
): { variable: string; port: string } | undefined {
  const m = portEntries(service)
    .map((entry) =>
      new RegExp(`^127\\.0\\.0\\.1:\\$\\{(\\w+):-(\\d+)\\}:${containerPort}$`).exec(entry),
    )
    .find(Boolean);
  return m ? { variable: m[1] ?? '', port: m[2] ?? '' } : undefined;
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
      // Read by docker-compose.dev.yml for its host ports and project name, never by the app.
      'COMPOSE_PROJECT_NAME',
      'POSTGRES_HOST_PORT',
      'VALKEY_HOST_PORT',
      'LOCALSTACK_HOST_PORT',
      'OTEL_OTLP_HOST_PORT',
      'OTEL_METRICS_HOST_PORT',
      'MAILPIT_SMTP_HOST_PORT',
      'MAILPIT_UI_HOST_PORT',
      'SEED_ON_DEPLOY',
      'WEB_DEV_PORT',
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
    // The proxy target is API_TARGET, or http://localhost:PORT from the root .env (default 3000): PORT must match it.
    const fallback = /dotenv\.PORT \|\| (\d+)/.exec(vite)?.[1];
    expect(fallback, 'no PORT fallback found in apps/web/vite.config.ts').toBeDefined();
    expect(env['PORT']).toBe(fallback);
    expect((vite.match(/target: apiOrigin/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('connects as a role a fresh database lets log in', () => {
    // The compose stack's only login is the superuser. The restricted roles are NOLOGIN until someone grants a password.
    expect(new URL(env['DATABASE_URL'] ?? '').username).toBe('postgres');
    expect(compose).toContain('POSTGRES_USER: postgres');
    expect(compose).toContain('POSTGRES_PASSWORD: postgres');
    expect(new URL(env['DATABASE_URL'] ?? '').password).toBe('postgres');
  });

  it('points at the host ports docker-compose.dev.yml publishes, through the .env variable that sets each', () => {
    const postgres = publishedPort('postgres', 5432);
    const valkey = publishedPort('valkey', 6379);
    const localstack = publishedPort('localstack', 4566);
    const otel = publishedPort('otel', 4318);
    for (const published of [postgres, valkey, localstack, otel]) {
      expect(published, 'a compose service publishes no 127.0.0.1-bound host port').toBeDefined();
      expect(env[published?.variable ?? '']).toBe(published?.port);
    }
    expect(portOf(env['DATABASE_URL'])).toBe(env['POSTGRES_HOST_PORT']);
    expect(portOf(env['REDIS_URL'])).toBe(env['VALKEY_HOST_PORT']);
    expect(portOf(env['STORAGE_ENDPOINT'])).toBe(env['LOCALSTACK_HOST_PORT']);
    expect(portOf(env['AWS_ENDPOINT_URL'])).toBe(env['LOCALSTACK_HOST_PORT']);
    expect(portOf(env['OTEL_EXPORTER_OTLP_ENDPOINT'])).toBe(env['OTEL_OTLP_HOST_PORT']);
    expect(publishedPort('otel', 8889)?.variable).toBe('OTEL_METRICS_HOST_PORT');
  });

  it('publishes every host port on loopback only, whatever the syntax', () => {
    const services = Object.keys(composeDoc.services);
    const published = services.flatMap((service) =>
      portEntries(service).map((e) => `${service}: ${e}`),
    );
    expect(published.length).toBeGreaterThan(0);
    expect(published.filter((p) => !/: 127\.0\.0\.1:/.test(p))).toEqual([]);
  });

  it('gives every compose port variable a default that matches .env.example', () => {
    const interpolated = [...compose.matchAll(/\$\{(\w+):-(\d+)\}/g)];
    expect(interpolated.length).toBeGreaterThanOrEqual(5);
    for (const [, variable, value] of interpolated) {
      expect(env[variable ?? ''], `${variable} is missing from .env.example`).toBe(value);
    }
  });

  it('names no fixed container, so a second copy with its own COMPOSE_PROJECT_NAME can run beside this one', () => {
    expect(compose).not.toContain('container_name:');
    expect(compose).toMatch(/^name: rova$/m);
  });

  it('pins the images to the data-store track: PostgreSQL 18.6, Valkey 8.1.10', () => {
    expect(compose).toMatch(/image: postgres:18\.\d+\s*$/m);
    expect(compose).toMatch(/image: valkey\/valkey:8\.1\.\d+-alpine/);
  });

  it('names no fixed container anywhere a developer or CI reads, so a second project can run beside this one', () => {
    const scripts = readdirSync(join(ROOT, 'scripts'), { recursive: true }) as string[];
    const files = [
      '.env.example',
      '.github/workflows/web-ci.yml',
      '.github/workflows/backend-ci.yml',
      // README.md is not listed: its upgrade note names the old containers on purpose, to tell people to remove them.
      ...scripts
        .filter((f) => statSync(join(ROOT, 'scripts', f)).isFile())
        .map((f) => `scripts/${f}`),
    ];
    const named = /\brova-(postgres|valkey|localstack|otel)\b/;
    for (const file of files)
      expect(read(file), `${file} names a fixed container`).not.toMatch(named);
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
    const port = /WEB_DEV_PORT\)\s*\|\|\s*(\d+)/.exec(vite)?.[1];
    expect(port, 'apps/web/vite.config.ts does not default its port').toBeDefined();
    const origin = `http://localhost:${port}`;
    expect(vite).toContain('strictPort: true');
    expect(env['CORS_ORIGINS']).toBe(origin);
    expect(env['APP_BASE_URL']).toBe(origin);
    expect(bootstrap).toContain(`WEB_ORIGIN="\${WEB_ORIGIN:-${origin}}"`);
    expect(compose).toContain(`WEB_ORIGIN: http://localhost:\${WEB_DEV_PORT:-${port}}`);
    // Playwright takes its web port from WEB_DEV_PORT (or the table default), so the default is what must match the table.
    expect(read('apps/web/playwright.config.ts')).toContain("?? '5175'");
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

  it('sends mail from a domain this organisation owns, and locally only to Mailpit on this machine', () => {
    expect(env['EMAIL_PROVIDER']).toBe('smtp');
    expect(env['MAIL_SMTP_HOST']).toBe('localhost');
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

/**
 * The host ports every product owns, as published in the "Local development" page of .github. Each product's compose
 * defaults and .env.example must equal this block, so the three stacks run side by side without a clash.
 */
const PORT_BLOCK = {
  POSTGRES_HOST_PORT: '5420',
  VALKEY_HOST_PORT: '6320',
  LOCALSTACK_HOST_PORT: '4620',
  OTEL_OTLP_HOST_PORT: '4420',
  OTEL_METRICS_HOST_PORT: '8420',
  MAILPIT_SMTP_HOST_PORT: '1120',
  MAILPIT_UI_HOST_PORT: '8120',
  WEB_DEV_PORT: '5175',
  PORT: '3010',
} as const;

describe('the port block is the one the .github table publishes', () => {
  it.each(Object.entries(PORT_BLOCK))('%s defaults to %s in .env.example', (key, value) => {
    expect(env[key]).toBe(value);
  });

  it('the compose defaults match the same block', () => {
    for (const [key, value] of Object.entries(PORT_BLOCK)) {
      if (key === 'PORT') continue;
      expect(compose).toContain('${' + key + ':-' + value + '}');
    }
  });
});

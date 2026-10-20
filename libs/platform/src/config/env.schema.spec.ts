import { describe, it, expect } from 'vitest';
import { EnvSchema } from './env.schema';

/** Minimum that satisfies the rest of the schema, so these tests isolate the key pair. */
function env(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://u:p@localhost:5432/rova',
    REDIS_URL: 'redis://localhost:6379',
    CSRF_SECRET: 'x'.repeat(32),
    COOKIE_SECRET: 'y'.repeat(32),
    ENTRA_TENANT_ID: 'tenant',
    ENTRA_CLIENT_ID: 'client',
    ENTRA_CLIENT_SECRET: 'secret',
    ...overrides,
  };
}

describe('EnvSchema — identity 8 sign-in', () => {
  it('needs no JWT key pair and no BFF or redirect variable', () => {
    const result = EnvSchema.safeParse(env());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data).filter((k) => /^(JWT_|BFF_)/.test(k))).toEqual([]);
    expect(result.data.SSO_ALLOWED_EMAIL_DOMAINS).toBe('qnsc.vn');
    expect(result.data.SSO_JIT_ENABLED).toBe(true);
  });

  it('accepts the identity secret only at 32 characters or more, and an empty value as unset', () => {
    expect(EnvSchema.safeParse(env({ BETTER_AUTH_SECRET: 'x'.repeat(31) })).success).toBe(false);
    expect(EnvSchema.safeParse(env({ BETTER_AUTH_SECRET: 'x'.repeat(32) })).success).toBe(true);
    expect(EnvSchema.safeParse(env({ BETTER_AUTH_SECRET: '' })).success).toBe(true);
  });

  it('refuses the passwordless test sign-in in production', () => {
    const result = EnvSchema.safeParse(
      env({
        NODE_ENV: 'production',
        APP_BASE_URL: 'https://rova.example',
        IDENTITY_TEST_LOGIN: 'enabled',
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain('IDENTITY_TEST_LOGIN');
  });

  it('requires an https APP_BASE_URL in production: it is the redirect and cookie origin', () => {
    const result = EnvSchema.safeParse(
      env({ NODE_ENV: 'production', APP_BASE_URL: 'http://rova.example' }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain('APP_BASE_URL');
  });
});

describe('EnvSchema — REDIS_URL', () => {
  // It used to default to redis://localhost:6379. That is harmless locally and
  // dangerous everywhere else: a deployed task missing the injection connected to
  // nothing on its own loopback instead of failing to boot. Sessions live only in
  // Valkey, and the token denylist and rate limiter both FAIL OPEN when it is
  // unreachable — so the service answered healthz with 200 while revoked tokens kept
  // working and rate limiting was off.
  it('is required, with no localhost fallback', () => {
    const withoutRedis = env();
    delete (withoutRedis as Record<string, unknown>).REDIS_URL;
    const result = EnvSchema.safeParse(withoutRedis);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain('REDIS_URL');
  });

  it('rejects a value that is not a URL', () => {
    expect(EnvSchema.safeParse(env({ REDIS_URL: 'not-a-url' })).success).toBe(false);
    expect(EnvSchema.safeParse(env({ REDIS_URL: '' })).success).toBe(false);
  });

  it('accepts both the deployed and local schemes', () => {
    // Deployed nodes enable transit encryption, so the scheme is always rediss://.
    expect(
      EnvSchema.safeParse(env({ REDIS_URL: 'rediss://master.x.cache.amazonaws.com:6379' })).success,
    ).toBe(true);
    expect(EnvSchema.safeParse(env({ REDIS_URL: 'redis://localhost:6379' })).success).toBe(true);
  });
});

describe('EnvSchema — email transport', () => {
  /**
   * Graph is the only production transport. SES and Resend were removed (rova#717), so a deployment
   * that still names either one is refused at boot, rather than silently sending nothing.
   */
  it.each(['ses', 'resend'])('REFUSES the removed %s transport', (provider) => {
    const result = EnvSchema.safeParse(env({ EMAIL_PROVIDER: provider }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.includes('EMAIL_PROVIDER'))).toBe(true);
  });

  it('needs no sender for the dev provider, which only logs', () => {
    // The default. Local development and CI must not have to configure mail at all.
    expect(EnvSchema.safeParse(env({ EMAIL_PROVIDER: 'dev' })).success).toBe(true);
    expect(EnvSchema.safeParse(env()).success).toBe(true);
  });
});

describe('EnvSchema — refinements are not disabled by an early return', () => {
  /**
   * The storage-credential rule existed and never ran.
   *
   * `superRefine` opened with `if (env.DATABASE_URL) return;`, which returned out of the WHOLE
   * block — so every rule written after the database check was dead for any deploy that used a
   * database URL, which is every deploy we have. Both live rules are asserted here with
   * `DATABASE_URL` set, which is the configuration that used to skip them.
   */
  it('still checks the public-storage credential PAIR when DATABASE_URL is set', () => {
    const half = EnvSchema.safeParse(env({ STORAGE_PUBLIC_ACCESS_KEY_ID: 'AKIA' }));
    expect(half.success).toBe(false);

    const other = EnvSchema.safeParse(env({ STORAGE_PUBLIC_SECRET_ACCESS_KEY: 'secret' }));
    expect(other.success).toBe(false);

    const both = EnvSchema.safeParse(
      env({ STORAGE_PUBLIC_ACCESS_KEY_ID: 'AKIA', STORAGE_PUBLIC_SECRET_ACCESS_KEY: 'secret' }),
    );
    expect(both.success).toBe(true);
  });

  it('still reports missing database parts when DATABASE_URL is absent', () => {
    const { DATABASE_URL, ...withoutUrl } = env();
    // Asserted, not discarded: if the fixture ever stops setting a URL, this test would otherwise
    // "pass" while proving nothing about the branch it is here to cover. (It also keeps the binding
    // used — `no-unused-vars` only exempts `^_` for arguments, not for destructured variables.)
    expect(DATABASE_URL).toBeTruthy();

    const result = EnvSchema.safeParse(withoutUrl);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.message.includes('DATABASE_HOST'))).toBe(true);
  });
});

describe('EnvSchema — DATABASE_AUTH (removed)', () => {
  it('still accepts the password mode, which is now simply the only mode', () => {
    expect(EnvSchema.safeParse(env({ DATABASE_AUTH: 'password' })).success).toBe(true);
    expect(EnvSchema.safeParse(env()).success).toBe(true);
  });

  it('REFUSES iam with a message that says what to do, rather than ignoring it and failing on the first query', () => {
    const result = EnvSchema.safeParse(env({ DATABASE_AUTH: 'iam' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join(' ');
      expect(message).toContain('DATABASE_AUTH=iam is no longer supported');
    }
  });

  it('no longer lets the discrete parts omit DATABASE_PASSWORD', () => {
    const bag: Record<string, string | undefined> = {
      ...env(),
      DATABASE_HOST: 'db',
      DATABASE_PORT: '5432',
      DATABASE_NAME: 'rova',
      DATABASE_USER: 'rova',
    };
    delete bag.DATABASE_URL;
    const result = EnvSchema.safeParse(bag);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(' ')).toContain('DATABASE_PASSWORD');
    }
  });
});

describe('EnvSchema — EDGE_CLIENT_IP_SECRET', () => {
  const key = 'k'.repeat(32);

  it('is optional: development and CI have no Pages Function in front', () => {
    expect(EnvSchema.safeParse(env()).success).toBe(true);
  });

  it('accepts a 32-character key and a previous key', () => {
    expect(
      EnvSchema.safeParse(env({ EDGE_CLIENT_IP_SECRET: key, EDGE_CLIENT_IP_SECRET_PREVIOUS: key }))
        .success,
    ).toBe(true);
  });

  it('refuses a short key: it is a signing key, not a password', () => {
    const result = EnvSchema.safeParse(env({ EDGE_CLIENT_IP_SECRET: 'too-short' }));
    expect(result.success).toBe(false);
  });

  it('counts surrounding whitespace as nothing, as platform-http does at both ends', () => {
    expect(
      EnvSchema.safeParse(env({ EDGE_CLIENT_IP_SECRET: `  ${'k'.repeat(31)}  ` })).success,
    ).toBe(false);
    expect(EnvSchema.safeParse(env({ EDGE_CLIENT_IP_SECRET: `${key}\n` })).success).toBe(true);
  });

  it('treats an empty value as unset', () => {
    expect(EnvSchema.safeParse(env({ EDGE_CLIENT_IP_SECRET: '' })).success).toBe(true);
  });

  it('refuses a previous key without a current one: a rotation half done', () => {
    const result = EnvSchema.safeParse(env({ EDGE_CLIENT_IP_SECRET_PREVIOUS: key }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join(' ')).toContain(
        'EDGE_CLIENT_IP_SECRET_PREVIOUS is set but EDGE_CLIENT_IP_SECRET is not',
      );
    }
  });
});

describe('EnvSchema — EMAIL_PROVIDER=graph (Microsoft 365 mail)', () => {
  const SERVICE_APP = '33333333-3333-4333-8333-333333333333';
  const graph = {
    EMAIL_PROVIDER: 'graph',
    MAIL_GRAPH_SENDER: 'noreply-rova-dev@qnsc.vn',
    MAIL_GRAPH_CLIENT_ID: SERVICE_APP,
  };

  it('needs the mailbox it sends as, and no MAIL_FROM_EMAIL (Graph sends as the mailbox)', () => {
    const missing = EnvSchema.safeParse(env({ EMAIL_PROVIDER: 'graph' }));
    expect(missing.success).toBe(false);
    expect(
      !missing.success && missing.error.issues.some((i) => i.path[0] === 'MAIL_GRAPH_SENDER'),
    ).toBe(true);
    expect(EnvSchema.safeParse(env(graph)).success).toBe(true);
  });

  it('needs the Service app (not the sign-in app) that holds the Exchange role, and it must be an application id', () => {
    const missing = EnvSchema.safeParse(env({ ...graph, MAIL_GRAPH_CLIENT_ID: '' }));
    expect(missing.success).toBe(false);
    expect(
      !missing.success && missing.error.issues.some((i) => i.path[0] === 'MAIL_GRAPH_CLIENT_ID'),
    ).toBe(true);
    expect(EnvSchema.safeParse(env({ ...graph, MAIL_GRAPH_CLIENT_ID: 'not-a-uuid' })).success).toBe(
      false,
    );
  });

  it('refuses a sender that is not an address', () => {
    expect(EnvSchema.safeParse(env({ ...graph, MAIL_GRAPH_SENDER: 'Rova <a@b.c>' })).success).toBe(
      false,
    );
  });

  it('refuses an unreplaced release-template placeholder for the tenant, the mailbox and the Service app', () => {
    const placeholders: Record<string, string> = {
      ENTRA_TENANT_ID: '<ENTRA_TENANT_ID>',
      MAIL_GRAPH_SENDER: '<ROVA_PROD_MAILBOX>',
      MAIL_GRAPH_CLIENT_ID: '<ROVA_PROD_SERVICE_APP_ID>',
    };
    for (const [key, value] of Object.entries(placeholders)) {
      const result = EnvSchema.safeParse(env({ ...graph, [key]: value }));
      expect(result.success, key).toBe(false);
      expect(
        !result.success &&
          result.error.issues.some((i) => i.path[0] === key && i.message.includes('placeholder')),
        key,
      ).toBe(true);
    }
  });

  it('treats the empty strings Terraform injects for unset variables as unset', () => {
    const result = EnvSchema.safeParse(
      env({
        EMAIL_PROVIDER: 'dev',
        MAIL_GRAPH_SENDER: '',
        MAIL_GRAPH_CERTIFICATE: '',
        MAIL_GRAPH_FEDERATED_TOKEN_FILE: '',
      }),
    );
    expect(result.success).toBe(true);
    expect(result.success && result.data.MAIL_GRAPH_CERTIFICATE).toBeUndefined();
  });

  it('carries the credential for the worker (certificate now, federated token later)', () => {
    const result = EnvSchema.safeParse(
      env({
        ...graph,
        MAIL_GRAPH_CERTIFICATE: 'PEM',
        MAIL_GRAPH_FEDERATED_TOKEN_FILE: '/var/run/token',
      }),
    );
    expect(result.success && result.data.MAIL_GRAPH_CERTIFICATE).toBe('PEM');
    expect(result.success && result.data.MAIL_GRAPH_FEDERATED_TOKEN_FILE).toBe('/var/run/token');
  });
});

describe('EnvSchema — EMAIL_PROVIDER=smtp (Mailpit, development only)', () => {
  const smtp = {
    EMAIL_PROVIDER: 'smtp',
    MAIL_SMTP_HOST: 'localhost',
    MAIL_SMTP_PORT: '1120',
    MAIL_FROM_EMAIL: 'noreply@qnsc.vn',
  };

  it('needs the relay host and port, and a sender', () => {
    const missing = EnvSchema.safeParse(
      env({ EMAIL_PROVIDER: 'smtp', MAIL_FROM_EMAIL: 'noreply@qnsc.vn' }),
    );
    expect(missing.success).toBe(false);
    expect(
      !missing.success && missing.error.issues.some((i) => i.path[0] === 'MAIL_SMTP_HOST'),
    ).toBe(true);
    expect(EnvSchema.safeParse(env(smtp)).success).toBe(true);
  });

  it('refuses the relay in production, whatever else is set', () => {
    const result = EnvSchema.safeParse(env({ ...smtp, NODE_ENV: 'production' }));
    expect(result.success).toBe(false);
    expect(
      !result.success && result.error.issues.some((i) => i.message.includes('development only')),
    ).toBe(true);
  });

  it('rejects a port that is not a port', () => {
    expect(EnvSchema.safeParse(env({ ...smtp, MAIL_SMTP_PORT: '70000' })).success).toBe(false);
  });
});

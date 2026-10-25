import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMigrationPoolConfig, resolvePoolConfig } from './pg-pool-config';

const CA = '-----BEGIN CERTIFICATE-----\\nTEST\\n-----END CERTIFICATE-----\\n';

function caFile(): string {
  const path = join(
    tmpdir(),
    `pg-pool-spec-${process.pid}-${Math.random().toString(36).slice(2)}.pem`,
  );
  writeFileSync(path, CA);
  return path;
}

const PARTS = {
  DATABASE_HOST: 'db.internal',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'rova',
  DATABASE_USER: 'rova_app',
  DATABASE_PASSWORD: 'p@ss/word:1',
};

describe('resolvePoolConfig', () => {
  it('uses DATABASE_URL untouched when it is set', () => {
    const url = 'postgresql://localhost:5432/rova?sslmode=disable';
    expect(resolvePoolConfig({ DATABASE_URL: url }).connectionString).toBe(url);
  });

  it('composes a URL from the discrete parts, percent-encoding the credential', () => {
    const config = resolvePoolConfig(PARTS);
    // sslmode=require is stripped from the URL and expressed as an explicit ssl option (see pg-ssl.ts).
    const parsed = new URL(config.connectionString);
    expect(parsed.username).toBe('rova_app');
    expect(parsed.password).toBe('p%40ss%2Fword%3A1'); // percent-encoded: '@', '/' and ':' are structural in a URL
    expect(`${parsed.host}${parsed.pathname}`).toBe('db.internal:5432/rova');
    expect(parsed.searchParams.has('sslmode')).toBe(false);
    expect(config.ssl).toEqual({ rejectUnauthorized: false }); // no CA outside production: encrypted, unverified
  });

  it.each(Object.keys(PARTS))('fails loudly, naming %s, when it is the missing part', (key) => {
    expect(() => resolvePoolConfig({ ...PARTS, [key]: undefined })).toThrow(key);
  });

  it('hands pg a plain string connection, never a password callback', () => {
    // The IAM mode supplied `password` as a per-connection function. There is no such mode now.
    expect(resolvePoolConfig(PARTS)).not.toHaveProperty('password');
  });
});

describe('TLS from DATABASE_SSL_CA and NODE_ENV', () => {
  it('a CA turns on verify-full for the application pool', () => {
    const config = resolvePoolConfig({ ...PARTS, DATABASE_SSL_CA: caFile() });
    expect(config.ssl).toEqual({ ca: CA, rejectUnauthorized: true });
  });

  it('production with no CA fails closed, naming the variable', () => {
    expect(() => resolvePoolConfig({ ...PARTS, NODE_ENV: 'production' })).toThrow(
      /DATABASE_SSL_CA/,
    );
  });

  it('the migration connection obeys the same rule, also for DATABASE_MIGRATION_URL', () => {
    expect(() =>
      resolveMigrationPoolConfig({
        ...PARTS,
        NODE_ENV: 'production',
        DATABASE_MIGRATION_URL:
          'postgresql://postgres:p@db.internal:5432/rova_migrate?sslmode=require',
      }),
    ).toThrow(/DATABASE_SSL_CA/);
    const config = resolveMigrationPoolConfig({
      ...PARTS,
      DATABASE_SSL_CA: caFile(),
      DATABASE_MIGRATION_URL:
        'postgresql://postgres:p@db.internal:5432/rova_migrate?sslmode=require',
    });
    expect(new URL(config.connectionString).pathname).toBe('/rova_migrate');
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true });
  });

  it('sslmode=disable keeps local dev and CI plaintext in every mode', () => {
    expect(
      resolvePoolConfig({
        ...PARTS,
        DATABASE_URL: 'postgresql://u:p@localhost:5432/rova?sslmode=disable',
      }).ssl,
    ).toBeUndefined();
  });
});

describe('resolveMigrationPoolConfig', () => {
  it('prefers DATABASE_MIGRATION_URL, the hand-supplied privileged credential', () => {
    const config = resolveMigrationPoolConfig({
      ...PARTS,
      DATABASE_MIGRATION_URL: 'postgresql://db.internal:5432/rova_migrate?sslmode=disable',
    });
    expect(new URL(config.connectionString).pathname).toBe('/rova_migrate');
  });

  it('otherwise resolves like the application', () => {
    expect(resolveMigrationPoolConfig(PARTS)).toEqual(resolvePoolConfig(PARTS));
  });
});

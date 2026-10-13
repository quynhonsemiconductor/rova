import { describe, expect, it } from 'vitest';
import { resolveMigrationPoolConfig, resolvePoolConfig } from './pg-pool-config';

const PARTS = {
  DATABASE_HOST: 'db.internal',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'rova',
  DATABASE_USER: 'rova_app',
  DATABASE_PASSWORD: 'p@ss/word:1',
};

describe('resolvePoolConfig', () => {
  it('uses DATABASE_URL untouched when it is set', () => {
    const config = resolvePoolConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/rova?sslmode=disable',
    });
    expect(config.connectionString).toBe('postgresql://u:p@localhost:5432/rova?sslmode=disable');
  });

  it('composes a URL from the discrete parts, percent-encoding the credential', () => {
    const config = resolvePoolConfig(PARTS);
    // sslmode=require is stripped from the URL and expressed as an explicit ssl option (see pg-ssl.ts).
    expect(config.connectionString).toBe(
      'postgresql://rova_app:p%40ss%2Fword%3A1@db.internal:5432/rova',
    );
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it.each(Object.keys(PARTS))('fails loudly, naming %s, when it is the missing part', (key) => {
    expect(() => resolvePoolConfig({ ...PARTS, [key]: undefined })).toThrow(new RegExp(key));
  });

  it('hands pg a plain string connection, never a password callback', () => {
    // The IAM mode supplied `password` as a per-connection function. There is no such mode now.
    expect(resolvePoolConfig(PARTS)).not.toHaveProperty('password');
  });
});

describe('resolveMigrationPoolConfig', () => {
  it('prefers DATABASE_MIGRATION_URL, the hand-supplied privileged credential', () => {
    const config = resolveMigrationPoolConfig({
      ...PARTS,
      DATABASE_MIGRATION_URL: 'postgresql://migrate:secret@db.internal:5432/rova?sslmode=require',
    });
    expect(config.connectionString).toContain('migrate:secret@');
  });

  it('otherwise resolves like the application', () => {
    expect(resolveMigrationPoolConfig(PARTS)).toEqual(resolvePoolConfig(PARTS));
  });
});

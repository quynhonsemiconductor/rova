/**
 * Tests for the IAM authentication path.
 *
 * The behaviours worth protecting here are the ones whose absence produced silent,
 * load-dependent failures rather than errors:
 *
 *  - `password` must be a FUNCTION, not a resolved string. A string is the bug: it
 *    works for fifteen minutes and then fails only when the pool grows.
 *  - the function must be called PER CONNECTION, so a long-lived pool never presents
 *    an expired token.
 *  - tokens must be keyed per role, because the app and the migrator share a host and
 *    a token is signed for exactly one username.
 */
import { Signer } from '@aws-sdk/rds-signer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetIamTokenCache, getIamAuthToken, iamPasswordProvider } from './pg-iam';
import { resolveAuthMode, resolvePoolConfig } from './pg-pool-config';

vi.mock('@aws-sdk/rds-signer', () => ({
  Signer: vi.fn(),
}));

const SignerMock = vi.mocked(Signer);

/** Install a Signer whose getAuthToken returns a distinct token on every call. */
function stubSigner(): { getAuthToken: ReturnType<typeof vi.fn> } {
  let n = 0;
  const getAuthToken = vi.fn(() => Promise.resolve(`token-${++n}`));
  // A FUNCTION EXPRESSION, not an arrow: pg-iam calls `new Signer(...)`, and an arrow
  // function is not a constructor. An arrow here fails with "is not a constructor",
  // which reads like a bug in the code under test rather than in the stub.
  SignerMock.mockImplementation(function () {
    return { getAuthToken } as unknown as Signer;
  });
  return { getAuthToken };
}

const IAM_ENV = {
  DATABASE_AUTH: 'iam',
  DATABASE_HOST: 'qnsc-shared-dev.cdu0osqeojxv.ap-southeast-1.rds.amazonaws.com',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'rova',
  DATABASE_USER: 'rova',
  AWS_REGION: 'ap-southeast-1',
};

beforeEach(() => {
  __resetIamTokenCache();
  SignerMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getIamAuthToken', () => {
  it('signs with the full connection identity', async () => {
    stubSigner();

    await getIamAuthToken({
      hostname: 'db.example.com',
      port: 5432,
      username: 'rova',
      region: 'ap-southeast-1',
    });

    expect(SignerMock).toHaveBeenCalledWith({
      hostname: 'db.example.com',
      port: 5432,
      username: 'rova',
      region: 'ap-southeast-1',
    });
  });

  it('reuses one token across a connection storm, so warming a pool signs once', async () => {
    const { getAuthToken } = stubSigner();
    const opts = { hostname: 'db', port: 5432, username: 'rova', region: 'ap-southeast-1' };

    const tokens = await Promise.all(Array.from({ length: 10 }, () => getIamAuthToken(opts)));

    expect(new Set(tokens).size).toBe(1);
    expect(getAuthToken).toHaveBeenCalledTimes(1);
  });

  it('never shares a token between two roles on the same host', async () => {
    const { getAuthToken } = stubSigner();
    const base = { hostname: 'db', port: 5432, region: 'ap-southeast-1' };

    const app = await getIamAuthToken({ ...base, username: 'rova' });
    const migrator = await getIamAuthToken({ ...base, username: 'rova_migrator' });

    // A token is signed for one username. Sharing one fails with a signature error
    // that names neither role — so this assertion is worth more than it looks.
    expect(app).not.toBe(migrator);
    expect(getAuthToken).toHaveBeenCalledTimes(2);
  });

  it('mints again once the reuse window has passed', async () => {
    const { getAuthToken } = stubSigner();
    vi.useFakeTimers();
    const opts = { hostname: 'db', port: 5432, username: 'rova', region: 'ap-southeast-1' };

    await getIamAuthToken(opts);
    vi.advanceTimersByTime(6_000);
    await getIamAuthToken(opts);

    expect(getAuthToken).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure, so the next connection retries', async () => {
    let calls = 0;
    const getAuthToken = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('transient'))
        : Promise.resolve('recovered-token');
    });
    SignerMock.mockImplementation(function () {
      return { getAuthToken } as unknown as Signer;
    });
    const opts = { hostname: 'db', port: 5432, username: 'rova', region: 'ap-southeast-1' };

    await expect(getIamAuthToken(opts)).rejects.toThrow('transient');
    // Holding the rejected promise would turn one blip into five seconds of
    // guaranteed connection failures.
    await expect(getIamAuthToken(opts)).resolves.toBe('recovered-token');
  });

  it('propagates a signing failure rather than yielding an empty credential', async () => {
    const getAuthToken = vi.fn(() =>
      Promise.reject(new Error('Could not load credentials from any providers')),
    );
    SignerMock.mockImplementation(function () {
      return { getAuthToken } as unknown as Signer;
    });

    await expect(
      iamPasswordProvider({ hostname: 'db', port: 5432, username: 'rova', region: 'x' })(),
    ).rejects.toThrow(/credentials/);
  });
});

describe('resolveAuthMode', () => {
  it('defaults to password, so the running ECS estate is unaffected', () => {
    expect(resolveAuthMode({})).toBe('password');
  });

  it.each(['iam', 'IAM', ' iam '])('accepts %s', (value) => {
    expect(resolveAuthMode({ DATABASE_AUTH: value })).toBe('iam');
  });

  it('rejects an unknown mode instead of silently falling back', () => {
    expect(() => resolveAuthMode({ DATABASE_AUTH: 'rdsproxy' })).toThrow(
      /must be "password" or "iam"/,
    );
  });
});

describe('resolvePoolConfig', () => {
  it('keeps the connection-string shape in password mode', () => {
    const config = resolvePoolConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/rova?sslmode=require',
    });

    expect(config.connectionString).toContain('localhost:5432');
    expect(config.password).toBeUndefined();
  });

  it('supplies password as a FUNCTION in iam mode, never a string', () => {
    stubSigner();

    const config = resolvePoolConfig(IAM_ENV);

    // This is the assertion that matters most in this file. A string here IS the
    // fifteen-minute bug.
    expect(typeof config.password).toBe('function');
    expect(config.connectionString).toBeUndefined();
    expect(config).toMatchObject({
      host: IAM_ENV.DATABASE_HOST,
      port: 5432,
      database: 'rova',
      user: 'rova',
    });
  });

  it('re-mints per connection rather than capturing one token', async () => {
    const { getAuthToken } = stubSigner();
    const provider = resolvePoolConfig(IAM_ENV).password as () => Promise<string>;

    vi.useFakeTimers();
    await provider();
    vi.advanceTimersByTime(6_000);
    await provider();

    expect(getAuthToken).toHaveBeenCalledTimes(2);
  });

  it('always requires TLS, because RDS rejects an unencrypted token handshake', () => {
    stubSigner();
    expect(resolvePoolConfig(IAM_ENV).ssl).toEqual({ rejectUnauthorized: false });
  });

  it('does not require DATABASE_PASSWORD, which an rds_iam role does not have', () => {
    stubSigner();
    expect(() => resolvePoolConfig(IAM_ENV)).not.toThrow();
  });

  it('refuses iam mode together with DATABASE_URL', () => {
    expect(() =>
      resolvePoolConfig({ ...IAM_ENV, DATABASE_URL: 'postgresql://u:p@h:5432/d' }),
    ).toThrow(/mutually exclusive/);
  });

  it.each(['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER'])(
    'fails loudly when %s is missing in iam mode',
    (key) => {
      expect(() => resolvePoolConfig({ ...IAM_ENV, [key]: undefined })).toThrow(new RegExp(key));
    },
  );
});

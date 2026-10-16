import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { importSPKI, jwtVerify } from 'jose';
import { RetryAfterError } from '@platform';
import { GithubAppAuthService } from './github-app-auth.service';

// A throwaway RSA keypair so we can sign + verify a real App JWT.
const { publicKey: PUBLIC_PEM, privateKey: PRIVATE_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: PRIVATE_PEM,
    GITHUB_API_BASE_URL: 'https://api.github.com',
    ...overrides,
  };
  return { get: (k: string) => values[k] } as never;
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response;
}

describe('GithubAppAuthService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('isConfigured reflects app id + a private-key source', () => {
    expect(new GithubAppAuthService(makeConfig()).isConfigured()).toBe(true);
    expect(new GithubAppAuthService(makeConfig({ GITHUB_APP_ID: '' })).isConfigured()).toBe(false);
    expect(
      new GithubAppAuthService(makeConfig({ GITHUB_APP_PRIVATE_KEY: '' })).isConfigured(),
    ).toBe(false);
  });

  it('resolveInstallationId signs a valid RS256 App JWT (iss = app id) and returns the id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 99 }));
    const svc = new GithubAppAuthService(makeConfig());

    const id = await svc.resolveInstallationId('acme/demo');
    expect(id).toBe('99');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/demo/installation');
    const auth = (init.headers as Record<string, string>).Authorization;
    const jwt = auth.replace('Bearer ', '');
    const { payload } = await jwtVerify(jwt, await importSPKI(PUBLIC_PEM, 'RS256'));
    expect(payload.iss).toBe('123');
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(10 * 60);
  });

  it('caches the installation token (one network call for repeat requests)', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    fetchMock.mockResolvedValue(jsonResponse({ token: 'ghs_abc', expires_at: expiresAt }));
    const svc = new GithubAppAuthService(makeConfig());

    expect(await svc.getInstallationToken('99')).toBe('ghs_abc');
    expect(await svc.getInstallationToken('99')).toBe('ghs_abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app/installations/99/access_tokens');
    expect(init.method).toBe('POST');
  });

  it('throws a helpful error on a failed App request', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' });
    const svc = new GithubAppAuthService(makeConfig());
    await expect(svc.resolveInstallationId('acme/missing')).rejects.toThrow(/failed \(404\)/);
  });

  describe('rate limits', () => {
    const limited = (status: number, headers: Record<string, string>) =>
      ({
        ok: false,
        status,
        headers: new Headers(headers),
        text: async () => 'rate limited',
      }) as Response;

    it("a secondary rate limit (403 + Retry-After) becomes a RetryAfterError with the server's wait", async () => {
      fetchMock.mockResolvedValueOnce(limited(403, { 'retry-after': '90' }));
      const err: unknown = await new GithubAppAuthService(makeConfig())
        .resolveInstallationId('acme/demo')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RetryAfterError);
      expect((err as RetryAfterError).retryAfterMs).toBe(90_000);
    });

    it('a plain 403 (a permission, not a rate limit) stays an ordinary error', async () => {
      fetchMock.mockResolvedValueOnce(limited(403, {}));
      const err: unknown = await new GithubAppAuthService(makeConfig())
        .resolveInstallationId('acme/demo')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(RetryAfterError);
    });
  });
});

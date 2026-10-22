import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryAfterError } from '@platform';
import { GithubRestClient, rateLimitWaitMs } from './github-rest.client';

const response = (status: number, headers: Record<string, string> = {}) =>
  ({
    ok: status < 400,
    status,
    headers: new Headers(headers),
    text: async () => 'body',
    json: async () => [],
  }) as Response;

describe('GithubRestClient rate limits', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const client = () => new GithubRestClient('https://api.github.com', 'tok');

  it('turns a 429 with Retry-After into a RetryAfterError carrying the wait', async () => {
    fetchMock.mockResolvedValueOnce(response(429, { 'retry-after': '45' }));
    const err: unknown = await client()
      .listPullRequests('acme/demo')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryAfterError);
    expect((err as RetryAfterError).retryAfterMs).toBe(45_000);
  });

  it('turns an exhausted primary limit (403, remaining 0, reset in the future) into a RetryAfterError', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 300);
    fetchMock.mockResolvedValueOnce(
      response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }),
    );
    const err: unknown = await client()
      .listPullRequests('acme/demo')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryAfterError);
    expect((err as RetryAfterError).retryAfterMs).toBeGreaterThan(250_000);
  });

  it('leaves a 404, a 500 and a plain 403 as ordinary errors', async () => {
    for (const status of [404, 500, 403]) {
      fetchMock.mockResolvedValueOnce(response(status));
      const err: unknown = await client()
        .listPullRequests('acme/demo')
        .catch((e: unknown) => e);
      expect(err, `status ${status}`).toBeInstanceOf(Error);
      expect(err, `status ${status}`).not.toBeInstanceOf(RetryAfterError);
    }
  });

  it('rateLimitWaitMs ignores statuses that are not rate limits even with a Retry-After', () => {
    expect(rateLimitWaitMs(response(500, { 'retry-after': '5' }))).toBeUndefined();
    expect(rateLimitWaitMs(response(429, { 'retry-after': '5' }))).toBe(5_000);
  });
});

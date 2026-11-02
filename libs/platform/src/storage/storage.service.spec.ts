import { describe, it, expect, beforeEach } from 'vitest';
import { StorageService } from './storage.service';
import type { AppConfigService } from '../config/app-config.service';
import type { ResilienceService } from '../resilience/resilience.service';
import { ResiliencePreset } from '../resilience/resilience.types';

/**
 * These assert the CONTRACT BETWEEN the presigned URL and the headers the client
 * is told to send. That contract is invisible to type checking and was wrong in
 * production: presignPut advertised `x-amz-checksum-sha256` as required, but the
 * presigner never signed it. S3/R2 rejects an unsigned x-amz-* header with a 403
 * whose response carries no CORS headers, so the browser reported an opaque
 * "Failed to fetch" and every upload failed.
 *
 * Nothing else catches this — the SDK ignores the checksum silently, and no
 * mock-based test that stubs the SDK can see it. So these tests use the REAL
 * presigner and inspect the URL it emits.
 */
describe('StorageService — presigned PUT contract', () => {
  let service: StorageService;

  const config = {
    get: (k: string) =>
      (
        ({
          S3_ATTACHMENTS_BUCKET: 'rally-test-attachments',
          S3_PUBLIC_ASSETS_BUCKET: 'rally-test-public',
          CDN_PUBLIC_ASSETS_BASE_URL: undefined,
          STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
          STORAGE_ACCESS_KEY_ID: 'AKIAEXAMPLE',
          STORAGE_SECRET_ACCESS_KEY: 'secretexample',
          STORAGE_FORCE_PATH_STYLE: true,
        }) as Record<string, unknown>
      )[k],
  } as unknown as AppConfigService;

  // Pass through, so the real presigner runs.
  const resilience = {
    execute: <T>(_n: string, fn: () => Promise<T>) => fn(),
  } as unknown as ResilienceService;

  beforeEach(() => {
    service = new StorageService(config, resilience);
  });

  const presign = () =>
    service.presignPut({
      key: 'work-item-attachment/ws/file.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
      visibility: 'private',
    });

  it('requires exactly the headers the signature covers', async () => {
    const { uploadUrl, requiredHeaders } = await presign();
    const signed = decodeURIComponent(
      new URL(uploadUrl).searchParams.get('X-Amz-SignedHeaders') ?? '',
    )
      .split(';')
      .filter((h) => h !== 'host');

    // Every advertised header must be signed …
    for (const name of Object.keys(requiredHeaders)) {
      expect(signed).toContain(name.toLowerCase());
    }
    // … and no x-amz-* header may be advertised that the signature omits.
    const unsignedAmz = Object.keys(requiredHeaders).filter(
      (h) => h.toLowerCase().startsWith('x-amz-') && !signed.includes(h.toLowerCase()),
    );
    expect(unsignedAmz).toEqual([]);
  });

  it('does not advertise a checksum header — a presigned PUT cannot carry one', async () => {
    const { uploadUrl, requiredHeaders } = await presign();
    expect(Object.keys(requiredHeaders)).toEqual(['Content-Type']);
    expect(new URL(uploadUrl).searchParams.get('X-Amz-SignedHeaders')).not.toContain('checksum');
  });

  it('binds content-type and content-length so the bucket rejects at the edge', async () => {
    const { uploadUrl } = await presign();
    const signed = decodeURIComponent(
      new URL(uploadUrl).searchParams.get('X-Amz-SignedHeaders') ?? '',
    );
    expect(signed).toContain('content-type');
    expect(signed).toContain('content-length');
  });

  it('refuses to store a public asset when no public bucket is configured', () => {
    const noPublic = {
      get: (k: string) =>
        k === 'S3_PUBLIC_ASSETS_BUCKET' ? undefined : (config.get as (key: string) => unknown)(k),
    } as unknown as AppConfigService;
    const svc = new StorageService(noPublic, resilience);
    // Must throw rather than silently fall back to the private bucket.
    return expect(
      svc.presignPut({ key: 'k', mimeType: 'image/png', sizeBytes: 1, visibility: 'public' }),
    ).rejects.toThrow(/S3_PUBLIC_ASSETS_BUCKET/);
  });
});

/**
 * The credential split is only real if the SIGNATURE differs — object identity of the
 * client proves nothing about which key R2 will check. So these read the access key id
 * back out of `X-Amz-Credential` on a presigned URL produced by the real presigner.
 *
 * Why it matters: one token covering both buckets means a leak exposes every
 * permission-gated attachment AND allows overwriting world-readable avatars and logos.
 */
describe('StorageService — public/private credential separation', () => {
  const resilience = {
    execute: <T>(_n: string, fn: () => Promise<T>) => fn(),
  } as unknown as ResilienceService;

  const baseEnv: Record<string, unknown> = {
    S3_ATTACHMENTS_BUCKET: 'rally-test-attachments',
    S3_PUBLIC_ASSETS_BUCKET: 'rally-test-public',
    CDN_PUBLIC_ASSETS_BASE_URL: undefined,
    STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    STORAGE_ACCESS_KEY_ID: 'PRIVATEKEYID',
    STORAGE_SECRET_ACCESS_KEY: 'privatesecret',
    STORAGE_FORCE_PATH_STYLE: true,
  };

  const make = (extra: Record<string, unknown> = {}) =>
    new StorageService(
      {
        get: (k: string) => ({ ...baseEnv, ...extra })[k],
      } as unknown as AppConfigService,
      resilience,
    );

  it('refuses to start without STORAGE_ENDPOINT: there is no plain-AWS mode', () => {
    expect(() => make({ STORAGE_ENDPOINT: undefined })).toThrow(/STORAGE_ENDPOINT is required/);
  });

  /** Access key id out of the SigV4 credential scope on a presigned URL. */
  const keyIdOf = (url: string) =>
    decodeURIComponent(new URL(url).searchParams.get('X-Amz-Credential') ?? '').split('/')[0];

  const presign = (svc: StorageService, visibility: 'private' | 'public') =>
    svc.presignGet({
      key: 'k',
      filename: 'f.png',
      mimeType: 'image/png',
      inline: false,
      visibility,
    });

  it('signs public-bucket URLs with the public credential when one is configured', async () => {
    const svc = make({
      STORAGE_PUBLIC_ACCESS_KEY_ID: 'PUBLICKEYID',
      STORAGE_PUBLIC_SECRET_ACCESS_KEY: 'publicsecret',
    });
    expect(keyIdOf(await presign(svc, 'public'))).toBe('PUBLICKEYID');
  });

  it('still signs private-bucket URLs with the private credential', async () => {
    const svc = make({
      STORAGE_PUBLIC_ACCESS_KEY_ID: 'PUBLICKEYID',
      STORAGE_PUBLIC_SECRET_ACCESS_KEY: 'publicsecret',
    });
    expect(keyIdOf(await presign(svc, 'private'))).toBe('PRIVATEKEYID');
  });

  // The rollout depends on this: infra injects the new env vars as empty secrets before
  // anyone mints the token, and that must behave exactly as it did before the split.
  it('falls back to the private credential for public assets when none is configured', async () => {
    const svc = make();
    expect(keyIdOf(await presign(svc, 'public'))).toBe('PRIVATEKEYID');
  });

  it('ignores a half-configured pair rather than signing with a partial credential', async () => {
    const svc = make({ STORAGE_PUBLIC_ACCESS_KEY_ID: 'PUBLICKEYID' });
    expect(keyIdOf(await presign(svc, 'public'))).toBe('PRIVATEKEYID');
  });

  it('targets the right bucket either way', async () => {
    const svc = make({
      STORAGE_PUBLIC_ACCESS_KEY_ID: 'PUBLICKEYID',
      STORAGE_PUBLIC_SECRET_ACCESS_KEY: 'publicsecret',
    });
    expect(await presign(svc, 'public')).toContain('rally-test-public');
    expect(await presign(svc, 'private')).toContain('rally-test-attachments');
  });
});

/**
 * `headObject` runs under two DIFFERENT resilience budgets — the long background one
 * for a future sweep or verifier, and a short interactive one for the request path
 * (`AttachmentsService.confirm`). These assert the routing rather than the numbers
 * (the numbers live in `resilience.presets.budgets.spec.ts`), because the failure
 * mode here is not a wrong constant: it is TWO BUDGETS SHARING ONE POLICY NAME.
 *
 * `ResilienceService.getOrCreatePolicy` caches by name and returns a cached entry
 * without comparing its options, so a single name would let whichever caller warmed
 * the cache first silently impose its timeout, retry count and circuit on the other
 * for the process lifetime — and on a low-traffic service that first caller is
 * whichever request happened to arrive after a deploy. Nothing about that is visible
 * at the call site, which is exactly why it is pinned.
 */
describe('StorageService — headObject resilience budget', () => {
  const calls: { name: string; preset: unknown }[] = [];

  // Does NOT invoke the operation: these cases are about which policy the call is
  // routed through, and running the real S3 client would make a network attempt.
  const resilience = {
    execute: (name: string, _fn: unknown, preset: unknown) => {
      calls.push({ name, preset });
      return Promise.resolve({ ContentLength: 42, ChecksumSHA256: null });
    },
  } as unknown as ResilienceService;

  const config = {
    get: (k: string) =>
      (
        ({
          S3_ATTACHMENTS_BUCKET: 'rally-test-attachments',
          S3_PUBLIC_ASSETS_BUCKET: 'rally-test-public',
          STORAGE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
          STORAGE_ACCESS_KEY_ID: 'AKIAEXAMPLE',
          STORAGE_SECRET_ACCESS_KEY: 'secretexample',
          STORAGE_FORCE_PATH_STYLE: true,
        }) as Record<string, unknown>
      )[k],
  } as unknown as AppConfigService;

  let service: StorageService;

  beforeEach(() => {
    calls.length = 0;
    service = new StorageService(config, resilience);
  });

  it('defaults to the long background budget', async () => {
    await service.headObject('k');
    expect(calls).toHaveLength(1);
    expect(calls[0].preset).toBe(ResiliencePreset.STORAGE);
  });

  it('honours an interactive budget when the caller asks for one', async () => {
    await service.headObject('k', 'private', ResiliencePreset.STORAGE_INTERACTIVE);
    expect(calls[0].preset).toBe(ResiliencePreset.STORAGE_INTERACTIVE);
  });

  it('gives the two budgets DISTINCT policy names, or one silently wins', async () => {
    await service.headObject('k');
    await service.headObject('k', 'private', ResiliencePreset.STORAGE_INTERACTIVE);
    expect(calls[0].name).not.toBe(calls[1].name);
    expect(new Set(calls.map((c) => c.name)).size).toBe(2);
  });

  it('keeps the policy name bounded — preset-derived, never key-derived', async () => {
    // A name built from the object key would put one policy (and one metric label
    // value) per uploaded file into the process. Two different keys, one name.
    await service.headObject('a/b/one.png', 'private', ResiliencePreset.STORAGE_INTERACTIVE);
    await service.headObject('a/b/two.png', 'private', ResiliencePreset.STORAGE_INTERACTIVE);
    expect(calls[0].name).toBe(calls[1].name);
    expect(calls[0].name).not.toContain('one.png');
  });
});

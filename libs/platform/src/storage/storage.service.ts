import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { ResilienceService } from '../resilience/resilience.service';
import { ResiliencePreset } from '../resilience/resilience.types';
import type {
  HeadObjectBudget,
  HeadObjectResult,
  PresignGetRequest,
  PresignPutRequest,
  PresignPutResult,
  StorageVisibility,
} from './storage.types';
import { DOWNLOAD_URL_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS } from './storage.types';

/**
 * Platform-level object storage service.
 *
 * Provides generic presign/head/delete primitives — no domain knowledge. Feature
 * modules go through AttachmentsService (which owns policy) rather than calling
 * this directly.
 *
 * Two buckets, selected per call by `visibility`:
 *
 *   private — everything permission-gated. Reachable only through a short-lived
 *             presigned GET minted after an authorization check.
 *   public  — CDN-fronted, world-readable by key. Only ever for non-sensitive
 *             assets (avatars, workspace logos).
 *
 * The split is enforced here rather than by convention because the failure mode
 * of getting it wrong is silent: a private object in a CDN-fronted bucket leaks
 * with no error anywhere.
 *
 * Registered as a global provider via PlatformModule — no need to re-import.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  /**
   * Client for the PUBLIC bucket. A distinct instance when public-scoped credentials
   * are configured, otherwise the same object as `s3` — so the unsplit case costs
   * nothing and behaves exactly as before.
   */
  private readonly publicS3: S3Client;
  private readonly privateBucket: string;
  private readonly publicBucket: string | null;
  private readonly cdnBaseUrl: string | null;

  readonly downloadTtlSeconds = DOWNLOAD_URL_TTL_SECONDS;

  constructor(
    private readonly config: AppConfigService,
    private readonly resilience: ResilienceService,
  ) {
    this.privateBucket = config.get('S3_ATTACHMENTS_BUCKET');
    this.publicBucket = config.get('S3_PUBLIC_ASSETS_BUCKET') ?? null;
    this.cdnBaseUrl = config.get('CDN_PUBLIC_ASSETS_BASE_URL') ?? null;

    // S3-compatible backend (Cloudflare R2 on-prem, Garage locally) with static credentials and
    // path-style addressing. There is no plain-AWS mode any more: the endpoint is required.
    const endpoint = config.get('STORAGE_ENDPOINT');
    if (!endpoint) {
      throw new Error(
        'STORAGE_ENDPOINT is required (S3-compatible endpoint: Cloudflare R2, or Garage locally)',
      );
    }
    const accessKeyId = config.get('STORAGE_ACCESS_KEY_ID');
    const secretAccessKey = config.get('STORAGE_SECRET_ACCESS_KEY');

    const publicAccessKeyId = config.get('STORAGE_PUBLIC_ACCESS_KEY_ID');
    const publicSecretAccessKey = config.get('STORAGE_PUBLIC_SECRET_ACCESS_KEY');

    const makeClient = (id?: string, secret?: string) =>
      new S3Client({
        region: 'auto',
        endpoint,
        forcePathStyle: config.get('STORAGE_FORCE_PATH_STYLE'),
        ...(id && secret ? { credentials: { accessKeyId: id, secretAccessKey: secret } } : {}),
        // SDK v3 defaults to auto-attaching a CRC32 checksum (x-amz-checksum-crc32 /
        // x-amz-sdk-checksum-algorithm) to PutObjectCommand, which bleeds into the
        // presigned URL's query string below. presignPut deliberately signs only
        // content-type/content-length (see its docstring — signableHeaders drift
        // here previously broke every upload), so an unsigned checksum param the
        // bucket's CORS AllowedHeaders doesn't list fails preflight with the same
        // opaque "Failed to fetch" that comment warns about. Disable it at the
        // client so PutObjectCommand never adds checksum params in the first place.
        requestChecksumCalculation: 'WHEN_REQUIRED',
      });

    this.s3 = makeClient(accessKeyId, secretAccessKey);

    // A SEPARATE client for the public bucket when it has its own credentials, so the
    // token that writes world-readable avatars cannot also read every permission-gated
    // attachment. Falls back to the same instance when they are unset, which keeps the
    // unsplit deployment byte-identical to before.
    this.publicS3 =
      publicAccessKeyId && publicSecretAccessKey
        ? makeClient(publicAccessKeyId, publicSecretAccessKey)
        : this.s3;
  }

  /**
   * The client that owns `visibility`'s bucket. Pairs with `bucketFor` — the two must
   * always be called with the SAME visibility, or a request is signed with the wrong
   * credential and R2 answers 403.
   */
  private clientFor(visibility: StorageVisibility): S3Client {
    return visibility === 'private' ? this.s3 : this.publicS3;
  }

  /**
   * Presigned PUT for direct client-to-bucket upload, expiring in
   * UPLOAD_URL_TTL_SECONDS (5 min).
   *
   * Content-Type and Content-Length are bound into the signature, so the bucket
   * rejects an upload that declares a different type or exceeds the declared
   * size — enforcement happens at the edge, not after the fact.
   *
   * The SHA-256 checksum is deliberately NOT sent by the client.
   *
   * An earlier version passed `ChecksumSHA256` and listed
   * `x-amz-checksum-sha256` in `signableHeaders`, intending the bucket to reject
   * a mismatched body. The presigner silently ignores it: the emitted
   * X-Amz-SignedHeaders is `content-length;content-type;host` in every variant
   * tried (command input, build-step header injection, and
   * finalizeRequest + unhoistableHeaders). The client then sent an x-amz-* header
   * the signature did not cover, S3/R2 rejected it 403, and because that error
   * response carries no CORS headers the browser surfaced it as an opaque
   * "Failed to fetch" — every upload failed.
   *
   * The digest the client computes is still stored on storage.files: it is the
   * dedup key and lets a background job verify content later. It is NOT enforced
   * at upload time. Anything claiming otherwise is wrong.
   *
   * Content-Disposition is baked in at PUT time so it is stored as object
   * metadata and therefore applies to EVERY later read — including a CDN read
   * that never passes through presignGet.
   *
   * ON THE RESILIENCE BUDGET (applies to presignGet too). Both presign methods run on
   * the request path with a user waiting, and both are deliberately LEFT on the
   * long-budget STORAGE preset rather than moved to STORAGE_INTERACTIVE, because
   * neither makes a network call: `getSignedUrl` is a local HMAC-SHA256 computation
   * over the canonical request, and the ~60s timeout it nominally sits under is
   * unreachable. The one theoretical exception is credential resolution, and it
   * does not apply: `STORAGE_ENDPOINT` is R2 with static `STORAGE_ACCESS_KEY_ID` /
   * `STORAGE_SECRET_ACCESS_KEY`, so no credential provider chain is walked. Changing these to the
   * interactive budget would add a retry to a pure function and buy nothing.
   */
  async presignPut(req: PresignPutRequest): Promise<PresignPutResult> {
    const uploadUrl = await this.resilience.execute(
      'storage.presignPut',
      () =>
        getSignedUrl(
          this.clientFor(req.visibility),
          new PutObjectCommand({
            Bucket: this.bucketFor(req.visibility),
            Key: req.key,
            ContentType: req.mimeType,
            ContentLength: req.sizeBytes,
          }),
          {
            expiresIn: UPLOAD_URL_TTL_SECONDS,
            signableHeaders: new Set(['content-type', 'content-length']),
          },
        ),
      ResiliencePreset.STORAGE,
    );

    // Exactly the headers the signature covers. Sending anything extra beginning
    // with x-amz- fails the signature; sending fewer fails it too.
    return { uploadUrl, requiredHeaders: { 'Content-Type': req.mimeType } };
  }

  /**
   * Presigned GET for time-limited private download, expiring in
   * DOWNLOAD_URL_TTL_SECONDS (15 min).
   *
   * Forces `Content-Disposition: attachment` unless the caller explicitly opts
   * into inline rendering. MIME is client-declared, so a file claiming to be a
   * PNG may contain script; serving it as a download makes that inert whatever
   * the bytes are. Only policies with a raster-only MIME set may pass inline.
   */
  async presignGet(req: PresignGetRequest): Promise<string> {
    return this.resilience.execute(
      'storage.presignGet',
      () =>
        getSignedUrl(
          this.clientFor(req.visibility),
          new GetObjectCommand({
            Bucket: this.bucketFor(req.visibility),
            Key: req.key,
            ResponseContentDisposition: this.contentDisposition(req.filename, req.inline),
            ResponseContentType: req.mimeType,
          }),
          { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
        ),
      ResiliencePreset.STORAGE,
    );
  }

  /**
   * HEAD an object to verify it was actually uploaded, and read back its size
   * and stored checksum. Returns null if the object does not exist.
   *
   * `budget` is REQUIRED READING for a new caller, because the failure it controls is
   * silent. This method swallows every error and returns null, and the only caller —
   * `AttachmentsService.confirm()` — reads null as "not uploaded" and answers 412. So
   * under the default background budget an R2 outage produced a MINUTES-long request
   * that ended in a 2xx or a 4xx: no 5xx alert fired, and the latency was clamped at
   * the histogram's old 10s ceiling. An interactive caller MUST pass
   * `ResiliencePreset.STORAGE_INTERACTIVE`. The default stays STORAGE so a future
   * background caller (a checksum verifier, an orphan sweep) gets the long budget it
   * wants without having to know this exists.
   */
  async headObject(
    key: string,
    visibility: StorageVisibility = 'private',
    budget: HeadObjectBudget = ResiliencePreset.STORAGE,
  ): Promise<HeadObjectResult | null> {
    try {
      const result = await this.resilience.execute(
        // The policy name CARRIES THE BUDGET, and it has to. `ResilienceService`
        // caches policies by name and returns a cached entry without comparing its
        // options (`getOrCreatePolicy`), so a single name shared by two budgets means
        // whichever caller ran first silently decides the timeout, the retry count
        // and the circuit for the other one, for the lifetime of the process. Both
        // values come from the ResiliencePreset enum, so this is bounded label
        // cardinality, not a constructed string.
        `storage.headObject:${budget}`,
        () =>
          this.clientFor(visibility).send(
            new HeadObjectCommand({
              Bucket: this.bucketFor(visibility),
              Key: key,
              ChecksumMode: 'ENABLED',
            }),
          ),
        budget,
      );
      return {
        contentLength: result.ContentLength ?? 0,
        checksumSha256: result.ChecksumSHA256 ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Hard-delete an object.
   * Errors are logged but NOT re-thrown — callers that have already soft-deleted
   * the DB record should treat object deletion as best-effort. The worker reaper
   * re-attempts anything that was missed.
   */
  async deleteObject(key: string, visibility: StorageVisibility = 'private'): Promise<void> {
    try {
      await this.resilience.execute(
        'storage.deleteObject',
        () =>
          this.clientFor(visibility).send(
            new DeleteObjectCommand({ Bucket: this.bucketFor(visibility), Key: key }),
          ),
        ResiliencePreset.STORAGE,
      );
    } catch (err) {
      this.logger.error({ key, err }, 'Failed to delete object — manual cleanup may be needed');
    }
  }

  /**
   * CDN URL for a PUBLIC object. Returns null when no CDN is configured.
   *
   * Deliberately has no private-bucket path. Fronting the private bucket with a
   * CDN domain would make every object readable by key, bypassing every
   * authorization check — and would turn any stored active content into
   * same-site XSS. Private objects are always served via presignGet.
   */
  cdnUrl(key: string): string | null {
    return this.cdnBaseUrl ? `${this.cdnBaseUrl}/${key}` : null;
  }

  private bucketFor(visibility: StorageVisibility): string {
    if (visibility === 'private') return this.privateBucket;
    if (!this.publicBucket) {
      throw new Error(
        'S3_PUBLIC_ASSETS_BUCKET is not configured — cannot store a public asset. ' +
          'Refusing to fall back to the private bucket.',
      );
    }
    return this.publicBucket;
  }

  /**
   * RFC 5987 encoding. The filename is attacker-controlled, so it is emitted
   * only in the escaped `filename*` form and never interpolated raw — a quote or
   * newline in a filename would otherwise let the caller inject header content.
   */
  private contentDisposition(filename: string, inline: boolean): string {
    const type = inline ? 'inline' : 'attachment';
    const safe = encodeURIComponent(filename).replace(/['()*]/g, (c) => {
      const code = c.charCodeAt(0).toString(16).toUpperCase();
      return `%${code}`;
    });
    return `${type}; filename*=UTF-8''${safe}`;
  }
}

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import { AppConfigService, RetryAfterError } from '@platform';
import { githubCallSignal } from './github-http';
import { rateLimitWaitMs } from './github-rest.client';
import { SECRET_RESOLVER, type ISecretResolver } from '@platform';

/**
 * Authenticates as the "Rally SCM" GitHub App (legacy physical name, do not rename) and mints short-lived installation
 * access tokens for REST calls (backfill). Flow:
 *   1. App JWT — RS256, signed with the App private key (iss = App ID, ≤10 min).
 *   2. Installation id — GET /repos/{o}/{r}/installation (Bearer app JWT).
 *   3. Installation token — POST /app/installations/{id}/access_tokens (~1h).
 * Tokens are cached per installation. github.com base is https://api.github.com;
 * a GHE host would be https://<host>/api/v3.
 */
/** Refresh a cached installation token this long before it actually expires. */
const TOKEN_REFRESH_BUFFER_MS = 60_000;
/** App-JWT `iat` is backdated this much to tolerate clock skew (GitHub requires ≤60s). */
const JWT_CLOCK_SKEW_SECONDS = 60;
/** App-JWT lifetime — under GitHub's 10-minute hard cap. */
const JWT_TTL_SECONDS = 9 * 60;

@Injectable()
export class GithubAppAuthService {
  private readonly logger = new Logger(GithubAppAuthService.name);
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();
  private privateKey: KeyObject | null = null;

  constructor(
    private readonly config: AppConfigService,
    @Optional() @Inject(SECRET_RESOLVER) private readonly secrets?: ISecretResolver,
  ) {}

  /** True when App ID + a private-key source are configured. */
  isConfigured(): boolean {
    return (
      !!this.config.get('GITHUB_APP_ID') &&
      (!!this.config.get('GITHUB_APP_PRIVATE_KEY') ||
        !!this.config.get('GITHUB_APP_PRIVATE_KEY_SECRET_REF'))
    );
  }

  get apiBaseUrl(): string {
    return this.config.get('GITHUB_API_BASE_URL');
  }

  /** Resolve the App installation id for a repo (owner/name). */
  async resolveInstallationId(fullName: string, signal?: AbortSignal): Promise<string> {
    const [owner, repo] = fullName.split('/');
    const body = await this.appRequest<{ id: number }>(
      `/repos/${owner}/${repo}/installation`,
      'GET',
      signal,
    );
    return String(body.id);
  }

  /** List every installation of this App (App-JWT). Used to connect an org. */
  async listInstallations(): Promise<
    Array<{ id: string; accountLogin: string | null; accountType: string | null }>
  > {
    const rows = await this.appRequest<
      Array<{ id: number; account?: { login?: string; type?: string } | null }>
    >('/app/installations?per_page=100');
    return rows.map((r) => ({
      id: String(r.id),
      accountLogin: r.account?.login ?? null,
      accountType: r.account?.type ?? null,
    }));
  }

  /** Get a cached (or fresh) installation access token. */
  async getInstallationToken(installationId: string, signal?: AbortSignal): Promise<string> {
    const hit = this.tokenCache.get(installationId);
    if (hit && hit.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) return hit.token;

    const body = await this.appRequest<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      'POST',
      signal,
    );
    this.tokenCache.set(installationId, {
      token: body.token,
      expiresAt: new Date(body.expires_at).getTime(),
    });
    return body.token;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async appRequest<T>(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    signal?: AbortSignal,
  ): Promise<T> {
    const jwt = await this.mintAppJwt();
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: githubCallSignal(signal),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const message = `GitHub App request ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`;
      const wait = rateLimitWaitMs(res);
      if (wait !== undefined) throw new RetryAfterError(message, wait);
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  private async mintAppJwt(): Promise<string> {
    const appId = this.config.get('GITHUB_APP_ID');
    if (!appId) throw new Error('GITHUB_APP_ID not configured');
    const key = await this.loadPrivateKey();
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(appId)
      .setIssuedAt(now - JWT_CLOCK_SKEW_SECONDS)
      .setExpirationTime(now + JWT_TTL_SECONDS)
      .sign(key);
  }

  /** Load + cache the App private key. Accepts PKCS#1 (GitHub's .pem) or PKCS#8. */
  private async loadPrivateKey(): Promise<KeyObject> {
    if (this.privateKey) return this.privateKey;
    const ref = this.config.get('GITHUB_APP_PRIVATE_KEY_SECRET_REF');
    let pem = this.config.get('GITHUB_APP_PRIVATE_KEY');
    if (!pem && ref) {
      if (!this.secrets) throw new Error('SECRET_RESOLVER unavailable to load GitHub App key');
      pem = await this.secrets.get(ref);
    }
    if (!pem) throw new Error('GitHub App private key not configured');
    // Secrets stored with literal "\n" — normalise to real newlines.
    this.privateKey = createPrivateKey(pem.replace(/\\n/g, '\n'));
    return this.privateKey;
  }
}

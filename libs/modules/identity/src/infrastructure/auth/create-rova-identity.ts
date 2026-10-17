import {
  createIdentity,
  type Identity,
  type SecurityEventSink,
} from '@quynhonsemiconductor/identity';
import {
  identityLoggerFrom,
  observabilitySecurityEvents,
} from '@quynhonsemiconductor/identity/nest';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { failOpenLog } from '@quynhonsemiconductor/observability';
import type { PinoLogger } from 'nestjs-pino';
import { IDENTITY_PRODUCT, type AppConfigService, type DrizzleDB } from '@platform';
import * as identityAuthSchema from '../../../../../../db/schema/identity-auth';
import type { StaffSignInHandler } from './staff-sign-in.handler';
import type { WorkspaceContext } from './workspace-context';

const UNCONFIGURED_ID = '00000000-0000-4000-8000-000000000000';

export interface RovaIdentityDeps {
  config: AppConfigService;
  db: DrizzleDB;
  cache: CacheService;
  staffSignIn: StaffSignInHandler;
  workspaceContext: WorkspaceContext;
  auditSink: SecurityEventSink;
  logger: PinoLogger;
  /**
   * The Entra authority (default `https://login.microsoftonline.com`). For the end-to-end sign-in suite, which points it
   * at identity's mock IdP; deliberately a code parameter and NOT an environment variable, so no deployment can be
   * configured to trust another login host.
   */
  staffAuthority?: string;
}

/**
 * THE one place rova builds identity 8 (`createIdentity`): the `staff` preset only, Microsoft Entra, single-tenant,
 * B2B guests allowed (vendors; the sign-in hook admits them only with a profile or a live invitation). Nothing else in
 * the repository imports the factory, and nothing imports `better-auth` at all (identity pins it; one place to upgrade,
 * every bump runs identity's conformance kit).
 *
 *  - `baseURL`/`trustedOrigins` are the SPA origin (`APP_BASE_URL`): the browser reaches `/api/auth/*` through the Pages
 *    Function on that origin, so the session cookie is set on the host the SPA uses, and Entra's redirect URI is
 *    `<APP_BASE_URL>/api/auth/callback/microsoft`.
 *  - `context`: the active workspace is the session's `contextId`, kept honest against `workspace_members`
 *    (`membership`) and defaulting to the member's most recently active workspace (`initial`); a member removed from a
 *    workspace loses it within 60 s per process (`revalidateSeconds`), or at once through `clearContext`.
 *  - No `mail`: the staff preset sends none.
 *  - Entra settings may be absent in development and CI (`test-login` signs in); production refuses that below.
 */
export function createRovaIdentity(deps: RovaIdentityDeps): Identity {
  const { config, logger } = deps;
  const appUrl = config.get('APP_BASE_URL');
  const metrics = observabilitySecurityEvents(logger);
  const events: SecurityEventSink = {
    emit: async (event) => {
      await metrics.emit(event);
      await deps.auditSink.emit(event);
    },
  };
  const production = config.get('NODE_ENV') === 'production';
  const entra = (key: 'ENTRA_TENANT_ID' | 'ENTRA_CLIENT_ID' | 'ENTRA_CLIENT_SECRET'): string => {
    const value = config.get(key);
    if (!value && production) throw new Error(`${key} is required when NODE_ENV=production`);
    return value || (key === 'ENTRA_CLIENT_SECRET' ? 'unconfigured' : UNCONFIGURED_ID);
  };
  return createIdentity({
    product: IDENTITY_PRODUCT,
    db: deps.db,
    schema: identityAuthSchema,
    cache: deps.cache,
    baseURL: appUrl,
    trustedOrigins: [appUrl],
    presets: ['staff'],
    staff: {
      tenantId: entra('ENTRA_TENANT_ID'),
      clientId: entra('ENTRA_CLIENT_ID'),
      clientSecret: entra('ENTRA_CLIENT_SECRET'),
      domains: config
        .get('SSO_ALLOWED_EMAIL_DOMAINS')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
      allowGuests: true,
      ...(deps.staffAuthority ? { authority: deps.staffAuthority } : {}),
    },
    context: {
      membership: (userId, contextId) => deps.workspaceContext.isActiveMember(userId, contextId),
      initial: (userId) => deps.workspaceContext.lastActiveFor(userId),
      revalidateSeconds: 60,
    },
    hooks: {
      onStaffSignIn: (user, claims) => deps.staffSignIn.handle({ user, claims }),
    },
    events,
    logger: identityLoggerFrom(logger),
    // Valkey failing under identity: sessions fall back to Postgres (safe), but the per-IP sign-in rate limit
    // (`increment`) FAILS OPEN, which is exactly what the rate_limit fail-open alarm exists to show.
    onStorageDegraded: (operation, error) =>
      logger.warn(
        {
          ...(operation === 'increment' ? failOpenLog('rate_limit') : {}),
          source: 'identity',
          operation,
          error: error instanceof Error ? error.name : 'unknown',
        },
        'identity session cache degraded',
      ),
    testLogin: config.get('IDENTITY_TEST_LOGIN') === 'enabled',
    env: {
      ...process.env,
      NODE_ENV: config.get('NODE_ENV'),
      ...(config.get('BETTER_AUTH_SECRET')
        ? { BETTER_AUTH_SECRET: config.get('BETTER_AUTH_SECRET') }
        : {}),
      ...(config.get('IDENTITY_TEST_LOGIN')
        ? { IDENTITY_TEST_LOGIN: config.get('IDENTITY_TEST_LOGIN') }
        : {}),
    },
  });
}

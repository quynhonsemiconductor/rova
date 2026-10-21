import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyCompress from '@fastify/compress';
import fastifyHelmet from '@fastify/helmet';
import { AppConfigService } from '@platform/config';
import { CSRF_HEADER, CSRF_SECRET_COOKIE, requiresCsrfProtection } from '@platform/http/csrf';
import { enableHealth, registerRequestTiming } from '@quynhonsemiconductor/platform-runtime';
import { SseConnections, registerSseShutdown } from '@modules/notifications';
import { assertEdgeClientIpEnv, enableCorrelationId } from '@quynhonsemiconductor/platform-http';
import { assertPlatformAdminEmailsEnv } from './platform-admin-emails';
import { SESSION_COOKIE } from '@platform/auth';
import { isSessionBody, redactSessionTokens } from '@platform/http/session-token-redaction';

/**
 * `/livez`, `/readyz` and the legacy `/v1/healthz`, `/v1/readyz`, as raw Fastify routes (`enableHealth`). Built in:
 * `database` (the pool, found by `DATABASE_POOL_TOKEN`, which `DatabaseModule` provides) and `cache` (when Valkey is
 * configured). Exported so a test can mount exactly what production mounts.
 */
export function enableProbes(app: NestFastifyApplication): void {
  enableHealth(app);
}

export async function bootstrapApp(app: NestFastifyApplication): Promise<void> {
  // The correlation id (and the request context that carries it) is seeded FIRST, by `app.use()`, which Nest runs
  // ahead of every middleware a module configures: so it covers module middleware, guards, filters, 404s and the
  // probe routes alike. Replaces `AsyncLocalStorageMiddleware` (deleted). Two differences from it, both deliberate
  // and listed in the PR: an id may be 1-128 characters of `[A-Za-z0-9._:-]` (was 8-64 of `[A-Za-z0-9_-]`), and
  // `X-Request-Id` is no longer read as a fallback.
  enableCorrelationId(app);

  const config = app.get(AppConfigService);

  // `clientIp()` (rate limiter, access log, idempotency, session and sign-in ip) reads EDGE_CLIENT_IP_SECRET lazily,
  // on the first request. A bad key is refused HERE, at boot, naming the variable, rather than surfacing as a
  // quietly disabled feature on whichever request arrives first.
  assertEdgeClientIpEnv();
  // The workspace-admin roster comes from the app bundle (platform-admin-emails key).
  // API-only: the worker never receives it and must boot without it, so the check
  // lives in this entrypoint, not in the shared env schema.
  assertPlatformAdminEmailsEnv(config.get('PLATFORM_ADMIN_EMAILS'), config.get('NODE_ENV'));
  // Two independent switches, not one `isDev`. They used to share
  // `NODE_ENV !== 'production'`, which meant any environment that isn't literally
  // "production" — staging, preview, a mis-set task definition — silently shipped
  // with CSP disabled AND the endpoint inventory published. Both now default
  // closed and are opted into explicitly.
  const swaggerEnabled = config.get('SWAGGER_ENABLED');

  // Register Fastify plugins
  await app.register(fastifyHelmet, {
    // CSP is always ON. When Swagger UI is served it needs its own inline script
    // and style, so widen those two directives for it specifically instead of
    // disabling the whole header (the previous `contentSecurityPolicy: false`).
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: swaggerEnabled ? ["'self'", "'unsafe-inline'"] : ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  // Response compression — reduces JSON payload size 60-80% (gzip/deflate/brotli)
  await app.register(fastifyCompress, { encodings: ['gzip', 'deflate', 'br'] });

  await app.register(fastifyCookie, {
    secret: config.get('COOKIE_SECRET'),
  });

  // ── CSRF (double-submit, session-bound) ─────────────────────────────────────
  // The secret lives in a signed `__Host-` cookie; the token is handed to the SPA
  // by GET /v1/auth/me and echoed back in the X-CSRF-Token header. `userInfo` binds
  // each token to the session id that requested it (HMAC'd with CSRF_SECRET), so a
  // token lifted from one session is useless in another.
  //
  // Registering the plugin only decorates `reply.generateCsrf()` and
  // `app.csrfProtection` — it enforces NOTHING until the hook below attaches it.
  // That gap is exactly how this protection came to be inert.
  await app.register(fastifyCsrf, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: CSRF_SECRET_COOKIE,
    cookieOpts: { signed: true, httpOnly: true, secure: true, sameSite: 'strict', path: '/' },
    // Header only. The default also reads `body._csrf`, which is never populated at
    // onRequest time (the body isn't parsed yet) and would read as "no token".
    getToken: (req) => {
      const header = req.headers[CSRF_HEADER];
      return Array.isArray(header) ? header[0] : header;
    },
    getUserInfo: (req) => req.cookies?.[SESSION_COOKIE] ?? '',
    csrfOpts: { hmacKey: config.get('CSRF_SECRET'), userInfo: true },
  });

  // Enforce on every cookie-authenticated state-changing request. Attaching the
  // check once here — rather than per route — means a new controller is covered by
  // default instead of opting in and being forgotten.
  const fastify = app.getHttpAdapter().getInstance();

  // identity answers get-session / list-sessions with each session's raw `token` in the JSON body, readable by script even though the
  // cookie is HttpOnly. Nothing in the SPA reads it: remove it on the way out (libs/platform/src/http/session-token-redaction.ts).
  fastify.addHook('onSend', async (request, reply, payload) => {
    if (!isSessionBody(request.url)) return payload;
    const redacted = redactSessionTokens(payload);
    // The body got shorter; a Content-Length copied from identity's own response would no longer match it.
    if (redacted !== payload) reply.removeHeader('content-length');
    return redacted;
  });

  // Registered BEFORE the CSRF gate, and before any hook that can reject: this only
  // stamps an arrival timestamp, and it has to run on every request that reaches the
  // process — including the ones something later refuses — or the access log loses
  // the arrival time for exactly the requests worth investigating.
  registerRequestTiming(fastify);

  // Probes: /livez, /readyz and the legacy /v1/healthz, /v1/readyz (the ALB target group, the Dockerfile
  // HEALTHCHECK, the post-deploy check and the chart's readiness path still use the /v1 pair). Raw Fastify routes,
  // so they sit outside the global prefix, the guards, the rate limiter and the OpenAPI document.
  //
  // /readyz answers 503 when the database or the cache is down, and always 503 once shutdown has begun (see
  // enableGracefulShutdown in main.ts).
  enableProbes(app);

  // Open notification streams are hijacked replies that never end on their own, so `fastify.close()` (the drain in
  // enableGracefulShutdown) would wait on every signed-in tab until the 25 s deadline. Their `preClose` hook sends
  // each one `reconnect` and ends it.
  registerSseShutdown(fastify, app.get(SseConnections));

  fastify.addHook('onRequest', function csrfGate(req, reply, done) {
    if (!requiresCsrfProtection(req)) return done();
    fastify.csrfProtection(req, reply, done);
  });

  // CORS
  app.enableCors({
    origin: config
      .get('CORS_ORIGINS')
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Correlation-Id',
      'X-CSRF-Token',
      'Idempotency-Key',
      'traceparent',
      'tracestate',
      'baggage',
    ],
    exposedHeaders: ['X-Correlation-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'Retry-After'],
  });

  // URI versioning: /v1/... The probes are NOT under it and need no exclusion: `enableHealth()` registers them as
  // raw Fastify routes (/livez, /readyz, /v1/healthz, /v1/readyz), outside Nest's routing. (`/livez` MUST be
  // unprefixed: the chart hardcodes it and `gitops/platform/policy/admission.yaml` denies any Deployment whose
  // liveness path is not exactly `/livez`.)
  app.setGlobalPrefix('v1');

  // OpenAPI — opt-in per environment via SWAGGER_ENABLED (default off)
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Rova API')
      .setDescription('Rova SaaS — project management platform API')
      .setVersion('1.0')
      .addCookieAuth(
        SESSION_COOKIE,
        { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE },
        'session',
      )
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'rly_<secret>' },
        'access-token',
      )
      .addTag('auth', 'Authentication & session management')
      .addTag('workspaces', 'Workspace management')
      .addTag('projects', 'Project management')
      .addTag('work-items', 'Work items (stories, tasks, defects, features)')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        filter: true,
        tryItOutEnabled: true,
        deepLinking: true,
        defaultModelsExpandDepth: 1,
      },
    });
  }

  // Graceful shutdown is `enableGracefulShutdown(app)` in main.ts — NOT app.enableShutdownHooks() here. That call
  // registers Nest's OWN SIGTERM/SIGINT listener that also calls app.close(), so a single SIGTERM used to fire BOTH
  // listeners and run every onModuleDestroy hook twice ("Called end on pool more than once" on every task stop).
  // enableGracefulShutdown() refuses to start if shutdown hooks are also enabled.
}

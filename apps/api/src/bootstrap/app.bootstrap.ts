import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import fastifyCookie from '@fastify/cookie';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyCompress from '@fastify/compress';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import { AppConfigService } from '@platform/config';
import { CSRF_HEADER, CSRF_SECRET_COOKIE, requiresCsrfProtection } from '@platform/http/csrf';
import { registerRequestTiming } from '@quynhonsemiconductor/platform-runtime';
import { BFF_SESSION_COOKIE } from '@platform/auth';

export async function bootstrapApp(app: NestFastifyApplication): Promise<void> {
  // Pino structured logger
  app.useLogger(app.get(Logger));
  app.flushLogs();

  const config = app.get(AppConfigService);
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
  // by GET /v1/bff/me and echoed back in the X-CSRF-Token header. `userInfo` binds
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
    getUserInfo: (req) => req.cookies?.[BFF_SESSION_COOKIE] ?? '',
    csrfOpts: { hmacKey: config.get('CSRF_SECRET'), userInfo: true },
  });

  // Enforce on every cookie-authenticated state-changing request. Attaching the
  // check once here — rather than per route — means a new controller is covered by
  // default instead of opting in and being forgotten.
  const fastify = app.getHttpAdapter().getInstance();

  // Registered BEFORE the CSRF gate, and before any hook that can reject: this only
  // stamps an arrival timestamp, and it has to run on every request that reaches the
  // process — including the ones something later refuses — or the access log loses
  // the arrival time for exactly the requests worth investigating.
  registerRequestTiming(fastify);

  fastify.addHook('onRequest', function csrfGate(req, reply, done) {
    if (!requiresCsrfProtection(req)) return done();
    fastify.csrfProtection(req, reply, done);
  });

  // Multipart / file upload — 10 MB limit per file
  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024 /* 10 MB */, files: 1 },
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

  // URI versioning: /v1/... (health probes are served at /v1/healthz and
  // /v1/readyz to match the ALB target-group health check, the Docker
  // HEALTHCHECK, and the post-deploy smoke test).
  app.setGlobalPrefix('v1');

  // OpenAPI — opt-in per environment via SWAGGER_ENABLED (default off)
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Rally API')
      .setDescription('Rally SaaS — project management platform API')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .addTag('auth', 'Authentication & session management')
      .addTag('workspaces', 'Workspace management')
      .addTag('projects', 'Project management')
      .addTag('work-items', 'Work items (stories, tasks, defects, features)')
      .addTag('health', 'Health & readiness probes')
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

  // Graceful shutdown is handled by main.ts's own SIGTERM/SIGINT listeners, which
  // flush OTel before calling app.close() — NOT app.enableShutdownHooks() here.
  // That call registers Nest's OWN SIGTERM/SIGINT listener that also calls
  // app.close(), so a single SIGTERM fired BOTH listeners, running app.close()
  // (and therefore every onModuleDestroy hook, including DrizzleProvider's
  // pool.end()) twice concurrently — the second call threw "Connection is
  // closed." / "Called end on pool more than once" on every task stop, visible
  // as a recurring ERROR log on every deploy and scale-down. Confirmed via the
  // shipped dashboards: worker's main.ts never calls enableShutdownHooks and
  // never showed this error.
}

/**
 * Request context — re-exported from `@quynhonsemiconductor/observability`.
 *
 * There must be exactly ONE `AsyncLocalStorage` instance in the process. The
 * package owns it because the package's logger mixin reads it and `withJobContext`
 * writes to it; if rova kept its own instance, HTTP requests would seed rova's
 * store while the mixin read the package's, and every request log line would
 * silently lose `workspaceId`, `userId` and `correlationId`. Nothing would fail —
 * the fields would just be absent.
 *
 * Kept as a re-export rather than deleted so the ~17 existing
 * `@platform/context/request-context` import sites stay valid, and so
 * `RequestContextService` remains the same class object that `PlatformModule`
 * provides (two copies of an @Injectable would be two DI tokens).
 */
export {
  RequestContextService,
  requestContextStorage,
  type RequestContext,
} from '@quynhonsemiconductor/observability';

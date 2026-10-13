export * from './public-config.controller';
/**
 * These now live in `@quynhonsemiconductor/observability`, re-exported here so the existing
 * `@platform` import sites stay valid — the same reason `context/request-context.ts`
 * is a re-export. The package is the single implementation; this is the façade.
 */
export {
  Span,
  type SpanOptions,
  failOpenLog,
  FAIL_OPEN_FIELD,
  type FailOpenControl,
  currentTraceparent,
  withRestoredTrace,
  IGNORED_REQUEST_PATHS,
} from '@quynhonsemiconductor/observability';

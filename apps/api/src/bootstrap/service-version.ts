/**
 * `SERVICE_VERSION` is what every log line (`version`), every span resource and the MCP
 * `initialize` answer report as the running release. The deployment does not set it: the chart
 * sets `OTEL_RESOURCE_ATTRIBUTES` with `service.version=<image tag>` (it is what labels the
 * spans), and the env schema's `SERVICE_VERSION` falls back to `'dev'`. So a prod pod logged
 * `"version":"dev"` for a real release.
 *
 * Fixing it in the app, not in a values file: the image tag is only known to the chart's
 * templating, so a static `SERVICE_VERSION: v0.8.6` in gitops would need an edit on every
 * release. `OTEL_RESOURCE_ATTRIBUTES` already carries the right value and is percent-encoded
 * per the OTel spec (`a=b,c=d`), so this reads `service.version` out of it ONCE, before the
 * shared bootstrap builds the logger and OTel provider.
 *
 * An explicit `SERVICE_VERSION` always wins — local runs and the e2e suites set it — and a
 * missing attribute changes nothing.
 */

/** The `service.version` value in an OTel resource-attribute string, or undefined. */
export function serviceVersionFromOtel(resourceAttributes: string | undefined): string | undefined {
  if (!resourceAttributes) return undefined;
  for (const pair of resourceAttributes.split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    if (pair.slice(0, separator).trim() !== 'service.version') continue;
    const raw = pair.slice(separator + 1).trim();
    if (!raw) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed escape is not worth failing the boot over; the literal is still better
      // than 'dev'.
      return raw;
    }
  }
  return undefined;
}

/**
 * Fills `env.SERVICE_VERSION` from `OTEL_RESOURCE_ATTRIBUTES` when the deployment did not set
 * it itself. Call before anything reads the env (the shared bootstrap creates the logger and the
 * OTel resource from `process.env`).
 */
export function applyServiceVersionFromOtel(env: NodeJS.ProcessEnv = process.env): void {
  if ((env['SERVICE_VERSION'] ?? '').trim() !== '') return;
  const version = serviceVersionFromOtel(env['OTEL_RESOURCE_ATTRIBUTES']);
  if (version) env['SERVICE_VERSION'] = version;
}

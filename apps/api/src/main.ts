import { createHttpApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { applyServiceVersionFromOtel } from './bootstrap/service-version';
import { apiAppOptions } from './app-options';

// The release the process reports (log `version`, span resource, MCP `initialize`) comes from
// OTEL_RESOURCE_ATTRIBUTES' service.version when the deployment does not set SERVICE_VERSION
// itself. Must run before the shared bootstrap builds the logger and the OTel provider.
applyServiceVersionFromOtel();

// The whole bootstrap lives in the shared library: `.env`, OpenTelemetry, the pino logger (JSON from the first line), graceful
// shutdown, the fatal handler. This product supplies only what is its own, in `app-options.ts`.
void createHttpApp(apiAppOptions);

import { createHttpApp } from '@quynhonsemiconductor/platform-runtime/bootstrap';
import { applyServiceVersionFromOtel } from './bootstrap/service-version';
import { apiAppOptions } from './app-options';

// The release the process reports (log `version`, span resource, MCP `initialize`) comes from
// OTEL_RESOURCE_ATTRIBUTES' service.version when the deployment does not set SERVICE_VERSION
// itself. Must run before the shared bootstrap builds the logger and the OTel provider.
//
// ORDER, verified against platform-runtime 0.3.4 (dist/bootstrap/index.js):
//   - importing `platform-runtime/bootstrap` transitively requires `config/load-env.js`, whose
//     top-level `process.loadEnvFile()` runs while the import above is evaluated — i.e. BEFORE
//     this statement. So an explicit SERVICE_VERSION or OTEL_RESOURCE_ATTRIBUTES written in a
//     `.env` is visible here, and `applyServiceVersionFromOtel` leaves it alone (explicit wins).
//   - `loadEnvFile` does NOT overwrite a variable already in the environment (verified on Node
//     24 by that module and its own test), so a shell/container env always beats the file.
//   - the logger and OTel provider are built inside `createHttpApp`, i.e. after this line.
applyServiceVersionFromOtel();

// The whole bootstrap lives in the shared library: `.env`, OpenTelemetry, the pino logger (JSON from the first line), graceful
// shutdown, the fatal handler. This product supplies only what is its own, in `app-options.ts`.
void createHttpApp(apiAppOptions);

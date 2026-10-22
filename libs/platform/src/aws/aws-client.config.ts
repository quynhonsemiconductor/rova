import type { AppConfigService } from '../config/app-config.service';

/**
 * Base configuration shared by every AWS SDK v3 client (S3, SES, SQS, Secrets Manager).
 * Only the fields the SDK constructors accept in common — feature-specific
 * options (e.g. S3 `forcePathStyle`) stay with their own client.
 */
export interface AwsClientBaseConfig {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/**
 * Single source of truth for building AWS SDK client configuration.
 *
 * Two mutually-exclusive modes, selected by whether `AWS_ENDPOINT_URL` is set:
 *
 *  - **Real AWS (prod / staging)** — `AWS_ENDPOINT_URL` unset. Returns region
 *    only; the SDK resolves credentials from the ECS task-role / instance-
 *    profile provider chain. NEVER injects static keys here (least-privilege).
 *
 *  - **Local dev / CI (an AWS emulator)** — `AWS_ENDPOINT_URL` set to an emulator's
 *    address. The default credential chain has no task role to resolve, so static
 *    credentials are passed explicitly. An emulator accepts any value; the
 *    conventional `test`/`test` is used as a fallback. Garage serves S3 locally
 *    (`STORAGE_ENDPOINT`); no local emulator serves SES or Secrets Manager.
 *
 * Reading from validated config (not `process.env`) is deliberate: `@nestjs/
 * config` only reliably surfaces schema-declared keys, so raw `process.env`
 * lookups return undefined in some processes (e.g. the worker) — which is the
 * exact reason endpoint/credentials were silently missing before.
 */
export function buildAwsClientConfig(config: AppConfigService): AwsClientBaseConfig {
  const region = config.get('AWS_REGION');
  const endpoint = config.get('AWS_ENDPOINT_URL');

  if (!endpoint) {
    return { region };
  }

  return {
    region,
    endpoint,
    credentials: {
      accessKeyId: config.get('AWS_ACCESS_KEY_ID') ?? 'test',
      secretAccessKey: config.get('AWS_SECRET_ACCESS_KEY') ?? 'test',
    },
  };
}

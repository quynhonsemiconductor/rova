/**
 * The roster of emails auto-granted workspace_admin on SSO sign-in. It arrives as the
 * `platform-admin-emails` key of the app bundle (it names staff, so it is not in git
 * and Terraform never sets it), injected into this API's env as PLATFORM_ADMIN_EMAILS.
 *
 * Checked HERE, at boot, and only here: the worker shares the env schema but never
 * receives the key and never grants admin, so it must boot without it. An empty roster
 * in a deployed environment would otherwise look healthy while silently granting
 * nobody — the failure mode is a refused boot, not a quiet downgrade.
 */
export function assertPlatformAdminEmailsEnv(roster: string, nodeEnv: string): void {
  if (roster.trim() || nodeEnv === 'development' || nodeEnv === 'test') return;
  throw new Error(
    'PLATFORM_ADMIN_EMAILS is empty: no SSO login would be granted workspace_admin. ' +
      'Set the platform-admin-emails key of the <product>/<env>/app bundle (comma-separated emails).',
  );
}

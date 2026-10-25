import { describe, expect, it } from 'vitest';
import { assertPlatformAdminEmailsEnv } from './platform-admin-emails';

describe('assertPlatformAdminEmailsEnv', () => {
  it('refuses an empty roster in production, naming the bundle key', () => {
    expect(() => assertPlatformAdminEmailsEnv('', 'production')).toThrow(/platform-admin-emails/);
    expect(() => assertPlatformAdminEmailsEnv('   ', 'production')).toThrow(
      /PLATFORM_ADMIN_EMAILS is empty/,
    );
  });

  it('accepts a non-empty roster in production', () => {
    expect(() => assertPlatformAdminEmailsEnv('devops@qnsc.vn', 'production')).not.toThrow();
  });

  it('lets local development and the test suite boot without a roster', () => {
    expect(() => assertPlatformAdminEmailsEnv('', 'development')).not.toThrow();
    expect(() => assertPlatformAdminEmailsEnv('', 'test')).not.toThrow();
  });
});

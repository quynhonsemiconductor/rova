import { describe, expect, it } from 'vitest';
import { applyServiceVersionFromOtel, serviceVersionFromOtel } from './service-version';

describe('serviceVersionFromOtel', () => {
  it('reads service.version out of the chart-rendered attribute list', () => {
    expect(
      serviceVersionFromOtel(
        'service.namespace=rova,deployment.environment=prod,service.version=0.8.6',
      ),
    ).toBe('0.8.6');
  });

  it('is not confused by a key that merely ends in service.version', () => {
    expect(serviceVersionFromOtel('x.service.version=nope,service.version=v1.2.3')).toBe('v1.2.3');
  });

  it('decodes the percent-encoding the OTel spec requires', () => {
    expect(serviceVersionFromOtel('service.version=v1.2.3%2B4')).toBe('v1.2.3+4');
  });

  it('returns undefined when the attribute is absent, empty or has no value', () => {
    expect(serviceVersionFromOtel(undefined)).toBeUndefined();
    expect(serviceVersionFromOtel('')).toBeUndefined();
    expect(serviceVersionFromOtel('service.version=')).toBeUndefined();
    expect(serviceVersionFromOtel('service.namespace=rova')).toBeUndefined();
  });
});

describe('applyServiceVersionFromOtel', () => {
  it('fills an unset SERVICE_VERSION from the attribute', () => {
    const env: NodeJS.ProcessEnv = { OTEL_RESOURCE_ATTRIBUTES: 'service.version=0.8.6' };
    applyServiceVersionFromOtel(env);
    expect(env['SERVICE_VERSION']).toBe('0.8.6');
  });

  it('never overrides an explicit SERVICE_VERSION, including a local "dev"', () => {
    const env: NodeJS.ProcessEnv = {
      SERVICE_VERSION: 'dev',
      OTEL_RESOURCE_ATTRIBUTES: 'service.version=0.8.6',
    };
    applyServiceVersionFromOtel(env);
    expect(env['SERVICE_VERSION']).toBe('dev');
  });

  it('leaves an empty deployment environment unchanged when the attribute is missing', () => {
    const env: NodeJS.ProcessEnv = {};
    applyServiceVersionFromOtel(env);
    expect(env['SERVICE_VERSION']).toBeUndefined();
  });
});

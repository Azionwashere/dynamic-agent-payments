import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfig } from '../src/lib/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetConfig();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
  });

  function setValidEnv() {
    process.env.DYNAMIC_ENVIRONMENT_ID = 'test-env-id';
    process.env.DYNAMIC_AUTH_TOKEN = 'dyn_testtoken123';
  }

  it('loads valid config from env vars', () => {
    setValidEnv();
    const config = loadConfig();
    expect(config.dynamicEnvironmentId).toBe('test-env-id');
    expect(config.dynamicAuthToken).toBe('dyn_testtoken123');
    expect(config.minFundingThresholdUsd).toBe('1.00');
    expect(config.checkoutApiBase).toBe('https://app.dynamicauth.com/api/v0');
  });

  it('throws when DYNAMIC_ENVIRONMENT_ID is missing', () => {
    process.env.DYNAMIC_AUTH_TOKEN = 'dyn_testtoken123';
    expect(() => loadConfig()).toThrow('dynamicEnvironmentId');
  });

  it('throws when DYNAMIC_AUTH_TOKEN does not start with dyn_', () => {
    process.env.DYNAMIC_ENVIRONMENT_ID = 'test-env-id';
    process.env.DYNAMIC_AUTH_TOKEN = 'bad_token';
    expect(() => loadConfig()).toThrow('dyn_');
  });

  it('uses default minFundingThresholdUsd when not set', () => {
    setValidEnv();
    const config = loadConfig();
    expect(config.minFundingThresholdUsd).toBe('1.00');
  });

  it('uses custom minFundingThresholdUsd when set', () => {
    setValidEnv();
    process.env.MIN_FUNDING_THRESHOLD_USD = '5.00';
    const config = loadConfig();
    expect(config.minFundingThresholdUsd).toBe('5.00');
  });

  it('caches config on second call', () => {
    setValidEnv();
    const first = loadConfig();
    const second = loadConfig();
    expect(first).toBe(second);
  });
});

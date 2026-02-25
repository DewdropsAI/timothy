import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRoute, getDefaultRoutes, type InvocationType } from '../router.js';

describe('resolveRoute', () => {
  const savedEnv: Record<string, string | undefined> = {};

  const envKeys = [
    'TITUS_CONVERSATION_MODEL',
    'TITUS_REFLECTION_MODEL',
    'TITUS_SUMMARIZATION_MODEL',
    'TITUS_EXTRACTION_MODEL',
    'TITUS_CONVERSATION_TIMEOUT_MS',
    'TITUS_REFLECTION_TIMEOUT_MS',
    'TITUS_SUMMARIZATION_TIMEOUT_MS',
    'TITUS_EXTRACTION_TIMEOUT_MS',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('returns default conversation route', () => {
    const route = resolveRoute('conversation');
    expect(route.model).toBe('claude-sonnet-4-6');
    expect(route.mode).toBe('yolo');
    expect(route.timeoutMs).toBe(300_000);
  });

  it('returns default reflection route', () => {
    const route = resolveRoute('reflection');
    expect(route.model).toBe('claude-haiku-4-5');
    expect(route.mode).toBe('print');
    expect(route.timeoutMs).toBe(60_000);
  });

  it('returns default summarization route', () => {
    const route = resolveRoute('summarization');
    expect(route.model).toBe('claude-haiku-4-5');
    expect(route.mode).toBe('print');
    expect(route.timeoutMs).toBe(30_000);
  });

  it('returns default extraction route', () => {
    const route = resolveRoute('extraction');
    expect(route.model).toBe('claude-haiku-4-5');
    expect(route.mode).toBe('print');
    expect(route.timeoutMs).toBe(30_000);
  });

  it('overrides model via env var', () => {
    process.env.TITUS_CONVERSATION_MODEL = 'claude-opus-4-6';
    const route = resolveRoute('conversation');
    expect(route.model).toBe('claude-opus-4-6');
    // mode and timeout should stay at defaults
    expect(route.mode).toBe('yolo');
    expect(route.timeoutMs).toBe(300_000);
  });

  it('overrides timeout via env var', () => {
    process.env.TITUS_REFLECTION_TIMEOUT_MS = '120000';
    const route = resolveRoute('reflection');
    expect(route.timeoutMs).toBe(120_000);
    // model and mode should stay at defaults
    expect(route.model).toBe('claude-haiku-4-5');
    expect(route.mode).toBe('print');
  });

  it('overrides both model and timeout via env vars', () => {
    process.env.TITUS_SUMMARIZATION_MODEL = 'claude-sonnet-4-6';
    process.env.TITUS_SUMMARIZATION_TIMEOUT_MS = '45000';
    const route = resolveRoute('summarization');
    expect(route.model).toBe('claude-sonnet-4-6');
    expect(route.timeoutMs).toBe(45_000);
  });

  it('ignores invalid timeout (NaN)', () => {
    process.env.TITUS_EXTRACTION_TIMEOUT_MS = 'not-a-number';
    const route = resolveRoute('extraction');
    expect(route.timeoutMs).toBe(30_000);
  });

  it('ignores non-positive timeout', () => {
    process.env.TITUS_EXTRACTION_TIMEOUT_MS = '0';
    const route = resolveRoute('extraction');
    expect(route.timeoutMs).toBe(30_000);
  });

  it('ignores negative timeout', () => {
    process.env.TITUS_EXTRACTION_TIMEOUT_MS = '-5000';
    const route = resolveRoute('extraction');
    expect(route.timeoutMs).toBe(30_000);
  });

  it('trims whitespace from model env var', () => {
    process.env.TITUS_CONVERSATION_MODEL = '  claude-opus-4-6  ';
    const route = resolveRoute('conversation');
    expect(route.model).toBe('claude-opus-4-6');
  });

  it('ignores empty model env var', () => {
    process.env.TITUS_CONVERSATION_MODEL = '   ';
    const route = resolveRoute('conversation');
    expect(route.model).toBe('claude-sonnet-4-6');
  });
});

describe('getDefaultRoutes', () => {
  it('returns all four invocation types', () => {
    const routes = getDefaultRoutes();
    const types: InvocationType[] = ['conversation', 'reflection', 'summarization', 'extraction'];
    expect(Object.keys(routes).sort()).toEqual(types.sort());
  });

  it('returns a copy (not the internal object)', () => {
    const a = getDefaultRoutes();
    const b = getDefaultRoutes();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { isTauriRuntime } from './runtime';

describe('isTauriRuntime', () => {
  const tauriInternals = '__TAURI_INTERNALS__' as const;

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown })[tauriInternals];
  });

  it('returns false in a plain browser environment', () => {
    expect(isTauriRuntime()).toBe(false);
  });

  it('returns true when tauri internals are present', () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown })[tauriInternals] = {};

    expect(isTauriRuntime()).toBe(true);
  });
});

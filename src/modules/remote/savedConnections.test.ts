/* @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { loadSavedConnections, saveSavedConnections } from './savedConnections';

describe('savedConnections', () => {
  it('round-trips saved connections through localStorage', () => {
    const savedConnection = {
      id: 'saved-1',
      name: 'prod',
      host: '10.0.0.15',
      port: 22,
      username: 'root',
      authType: 'password' as const,
    };

    saveSavedConnections([savedConnection]);

    expect(loadSavedConnections()).toEqual([savedConnection]);
  });
});

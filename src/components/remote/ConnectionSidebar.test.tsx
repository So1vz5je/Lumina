/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionSidebar } from './ConnectionSidebar';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('ConnectionSidebar', () => {
  it('shows the saved host names in the sidebar list', () => {
    render(
      <ConnectionSidebar
        connections={[
          {
            id: 'saved-1',
            name: 'prod',
            host: '10.0.0.15',
            port: 22,
            username: 'root',
            authType: 'password',
          },
        ]}
        activeConnectionId={null}
        onActivate={() => {}}
        onConnect={() => {}}
      />,
    );

    expect(screen.getByText('prod')).toBeInTheDocument();
  });
});

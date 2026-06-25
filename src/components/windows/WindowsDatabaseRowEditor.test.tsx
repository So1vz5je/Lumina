/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { WindowsDatabaseEditableColumn } from '../../modules/windowsDatabase/types';
import { WindowsDatabaseRowEditor } from './WindowsDatabaseRowEditor';

beforeAll(() => {
  const originalGetComputedStyle = window.getComputedStyle.bind(window);
  const getComputedStyleMock = vi.fn((element: Element) => originalGetComputedStyle(element));
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: getComputedStyleMock,
  });
  vi.stubGlobal('getComputedStyle', getComputedStyleMock);

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

const columns: WindowsDatabaseEditableColumn[] = [
  { name: 'id', dataType: 'int', nullable: false, key: 'PRI', required: false, generated: false, identity: true },
  { name: 'email', dataType: 'varchar(255)', nullable: false, required: true, generated: false, identity: false },
  { name: 'nickname', dataType: 'varchar(255)', nullable: true, required: false, generated: false, identity: false },
];

describe('WindowsDatabaseRowEditor', () => {
  it('blocks empty required values before submit', () => {
    const onSubmit = vi.fn();
    render(
      <WindowsDatabaseRowEditor
        open
        mode="insert"
        columns={columns}
        initialValues={{}}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('字段不能为空')).toBeInTheDocument();
  });

  it('submits normalized insert values', () => {
    const onSubmit = vi.fn();
    render(
      <WindowsDatabaseRowEditor
        open
        mode="insert"
        columns={columns}
        initialValues={{}}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('email'), { target: { value: 'a@example.com' } });
    fireEvent.change(screen.getByLabelText('nickname'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    expect(onSubmit).toHaveBeenCalledWith({ email: 'a@example.com', nickname: null });
  });

  it('locks identity fields during update', () => {
    render(
      <WindowsDatabaseRowEditor
        open
        mode="update"
        columns={columns}
        initialValues={{ id: '7', email: 'a@example.com', nickname: 'old' }}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('id')).toBeDisabled();
  });
});

/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  WindowsDatabaseAction,
  WindowsDatabaseEngine,
  WindowsDatabaseInstance,
  WindowsDatabaseQueryRequest,
} from '../../modules/windowsDatabase/types';
import {
  getReadonlyQueryHint,
  getWindowsDatabaseDisplayName,
} from '../../modules/windowsDatabase/sql';
import { WindowsDatabaseWorkbench } from './WindowsDatabaseWorkbench';

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
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
});

function mysqlWorkbenchInstance(): WindowsDatabaseInstance {
  return {
    id: 'mysql:127.0.0.1:3306',
    engine: 'mysql',
    displayName: 'MySQL',
    source: 'port',
    status: 'running',
    path: 'C:\\Program Files\\MySQL\\bin\\mysqld.exe',
    version: '8.0',
    host: '127.0.0.1',
    port: 3306,
    credentialMode: 'detected',
    credentialLabel: 'Detected from analyzer',
  };
}

describe('windows database detail contract', () => {
  it('matches the supported engines and actions contract', () => {
    const engines = ['mysql', 'sqlserver', 'postgresql'] as const satisfies readonly WindowsDatabaseEngine[];
    const actions = [
      'listDatabases',
      'listTables',
      'describeTable',
      'previewTable',
      'runReadonlyQuery',
    ] as const satisfies readonly WindowsDatabaseAction[];

    expectTypeOf<typeof engines[number]>().toEqualTypeOf<WindowsDatabaseEngine>();
    expectTypeOf<typeof actions[number]>().toEqualTypeOf<WindowsDatabaseAction>();
    expect(engines).toStrictEqual(['mysql', 'sqlserver', 'postgresql']);
    expect(actions).toStrictEqual([
      'listDatabases',
      'listTables',
      'describeTable',
      'previewTable',
      'runReadonlyQuery',
    ]);
  });

  it('matches the query request example contract', () => {
    const instance: WindowsDatabaseInstance = {
      id: 'mysql:MySQL80',
      engine: 'mysql',
      displayName: 'MySQL Server 8.0',
      source: 'service',
      status: 'running',
      path: 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe',
      version: '8.0',
      host: '127.0.0.1',
      port: 3306,
      credentialMode: 'detected',
      credentialLabel: 'Detected from analyzer',
    };
    const query: WindowsDatabaseQueryRequest = {
      engine: 'mysql',
      instanceId: instance.id,
      sql: 'SELECT id, email FROM users LIMIT 20',
      rowLimit: 20,
    };

    expectTypeOf(query).toEqualTypeOf<WindowsDatabaseQueryRequest>();
    expect(query).toStrictEqual({
      engine: 'mysql',
      instanceId: 'mysql:MySQL80',
      sql: 'SELECT id, email FROM users LIMIT 20',
      rowLimit: 20,
    });
  });

  it('describes supported engines and readonly query hints', () => {
    const instance: WindowsDatabaseInstance = {
      id: 'mysql:MySQL80',
      engine: 'mysql',
      displayName: 'MySQL Server 8.0',
      source: 'service',
      status: 'running',
      path: 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqld.exe',
      version: '8.0',
      host: '127.0.0.1',
      port: 3306,
      credentialMode: 'detected',
      credentialLabel: 'Detected from analyzer',
    };
    const query: WindowsDatabaseQueryRequest = {
      engine: 'mysql',
      instanceId: instance.id,
      sql: 'SELECT id, email FROM users LIMIT 20',
      rowLimit: 20,
    };

    expect(getWindowsDatabaseDisplayName(instance)).toBe('MySQL Server 8.0:3306');
    expect(
      getWindowsDatabaseDisplayName({
        ...instance,
        displayName: 'PostgreSQL',
        port: null,
      }),
    ).toBe('PostgreSQL');
    expect(getReadonlyQueryHint(query.engine)).toMatch(/SELECT|SHOW|DESCRIBE/i);
    expect(getReadonlyQueryHint('sqlserver')).toContain(
      'only SELECT / EXEC sp_help / EXEC sp_columns / EXEC sp_tables',
    );
    expect(getReadonlyQueryHint('postgresql')).toContain('only SELECT / WITH / EXPLAIN');
  });

  it('loads database navigation and structure preview for a SQL Server instance', async () => {
    const instance: WindowsDatabaseInstance = {
      id: 'sqlserver:MSSQLSERVER',
      engine: 'sqlserver',
      displayName: 'SQL Server',
      source: 'service',
      status: 'running',
      path: 'C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Binn\\sqlservr.exe',
      version: '16.0',
      host: '127.0.0.1',
      port: 1433,
      credentialMode: 'detected',
      credentialLabel: 'Detected from analyzer',
    };
    const onRequest = vi
      .fn()
      .mockResolvedValueOnce({ databases: ['appdb'] })
      .mockResolvedValueOnce({ tables: [{ schema: 'dbo', name: 'users' }] })
      .mockResolvedValueOnce({ columns: [{ name: 'id', dataType: 'int', nullable: false }] })
      .mockResolvedValueOnce({
        columns: ['id'],
        rows: [{ id: '1' }],
        rowCount: 1,
        truncated: false,
      });

    render(<WindowsDatabaseWorkbench instance={instance} onRequest={onRequest} />);

    expect(await screen.findByText('appdb')).toBeInTheDocument();

    fireEvent.click(screen.getByText('appdb'));

    expect(await screen.findByText('users')).toBeInTheDocument();

    fireEvent.click(screen.getByText('users'));

    expect(await screen.findByText('id')).toBeInTheDocument();
    await waitFor(() => {
      expect(onRequest).toHaveBeenCalledTimes(4);
    });
  });

  it('filters sqlcmd separator rows from database, table, and column navigation', async () => {
    const instance: WindowsDatabaseInstance = {
      id: 'sqlserver:MSSQLSERVER',
      engine: 'sqlserver',
      displayName: 'SQL Server',
      source: 'service',
      status: 'running',
      path: 'C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Binn\\sqlservr.exe',
      version: '16.0',
      host: '127.0.0.1',
      port: 1433,
      credentialMode: 'detected',
      credentialLabel: 'Detected from analyzer',
    };
    const onRequest = vi
      .fn()
      .mockResolvedValueOnce({ databases: ['1212512', '----------', 'policeinfo'] })
      .mockResolvedValueOnce({
        tables: [
          { schema: '----------', name: '----------' },
          { schema: 'dbo', name: 'cases' },
        ],
      })
      .mockResolvedValueOnce({
        columns: [
          { name: '----------', dataType: '----------', nullable: false },
          { name: 'Pno', dataType: 'int', nullable: false },
        ],
      })
      .mockResolvedValueOnce({
        columns: ['Pno'],
        rows: [{ Pno: '100001' }],
        rowCount: 1,
        truncated: false,
      });

    render(<WindowsDatabaseWorkbench instance={instance} onRequest={onRequest} />);

    expect(await screen.findByText('policeinfo')).toBeInTheDocument();
    expect(screen.queryByText('----------')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('policeinfo'));
    expect(await screen.findByText('cases')).toBeInTheDocument();
    expect(screen.queryByText('----------')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('cases'));
    expect(await screen.findByText('Pno')).toBeInTheDocument();
    expect(screen.queryByText('----------')).not.toBeInTheDocument();
  });

  it('keeps long database table lists inside fixed scroll regions', async () => {
    const manyTables = Array.from({ length: 60 }, (_, index) => ({
      schema: 'dbo',
      name: `table_${String(index + 1).padStart(2, '0')}`,
    }));
    const onRequest = vi
      .fn()
      .mockResolvedValueOnce({ databases: ['appdb'] })
      .mockResolvedValueOnce({ tables: manyTables });

    render(<WindowsDatabaseWorkbench instance={mysqlWorkbenchInstance()} onRequest={onRequest} />);

    const workbench = await screen.findByTestId('windows-database-workbench');
    expect(workbench).toHaveClass('windows-database-workbench');
    expect(workbench).toHaveStyle('height: 100%');
    expect(workbench).toHaveStyle('overflow: hidden');

    fireEvent.click(screen.getByText('appdb'));

    expect(await screen.findByText('table_60')).toBeInTheDocument();
    expect(screen.getByTestId('windows-database-nav')).toHaveStyle('overflow: hidden');
    expect(screen.getByTestId('windows-database-db-list')).toHaveStyle('overflow-y: auto');
    expect(screen.getByTestId('windows-database-table-list')).toHaveStyle('overflow-y: auto');
    expect(screen.getByTestId('windows-database-table-list')).toHaveStyle('min-height: 0');
  });

  it('renders database and table navigation items without native button chrome', async () => {
    const onRequest = vi
      .fn()
      .mockResolvedValueOnce({ databases: ['appdb'] })
      .mockResolvedValueOnce({ tables: [{ schema: 'dbo', name: 'users' }] });

    render(<WindowsDatabaseWorkbench instance={mysqlWorkbenchInstance()} onRequest={onRequest} />);

    const databaseItem = await screen.findByRole('button', { name: 'appdb' });
    expect(databaseItem.tagName).toBe('DIV');
    expect(databaseItem).toHaveClass('windows-database-nav-button');
    expect(databaseItem).toHaveStyle('border: none');

    fireEvent.click(databaseItem);

    const tableItem = await screen.findByRole('button', { name: /users/ });
    expect(tableItem.tagName).toBe('DIV');
    expect(tableItem).toHaveClass('windows-database-nav-button');
    expect(tableItem).toHaveStyle('border: none');
  });

  it('blocks non-readonly queries in the UI before sending them', async () => {
    const instance: WindowsDatabaseInstance = {
      id: 'mysql:127.0.0.1:3306',
      engine: 'mysql',
      displayName: 'MySQL',
      source: 'port',
      status: 'running',
      path: 'C:\\Program Files\\MySQL\\bin\\mysqld.exe',
      version: '8.0',
      host: '127.0.0.1',
      port: 3306,
      credentialMode: 'detected',
      credentialLabel: 'Detected from analyzer',
    };
    const onRequest = vi.fn().mockResolvedValueOnce({ databases: ['appdb'] });
    const { container } = render(<WindowsDatabaseWorkbench instance={instance} onRequest={onRequest} />);

    expect(await screen.findByText('appdb')).toBeInTheDocument();
    fireEvent.click(container.querySelector('[id$="-tab-query"]') as HTMLElement);
    fireEvent.change(screen.getByPlaceholderText(/SELECT/i), {
      target: { value: 'DELETE FROM users' },
    });
    fireEvent.click(screen.getByRole('button', { name: /执\s*行/ }));

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/只允许只读查询/)).toBeInTheDocument();
  });

  it('clamps readonly query row limits to 100 before sending them', async () => {
    const instance: WindowsDatabaseInstance = {
      id: 'postgresql:127.0.0.1:5432',
      engine: 'postgresql',
      displayName: 'PostgreSQL',
      source: 'port',
      status: 'running',
      path: 'C:\\Program Files\\PostgreSQL\\16\\bin\\postgres.exe',
      version: '16',
      host: '127.0.0.1',
      port: 5432,
      credentialMode: 'detected',
      credentialLabel: 'Detected from analyzer',
    };
    const onRequest = vi
      .fn()
      .mockResolvedValueOnce({ databases: ['appdb'] })
      .mockResolvedValueOnce({
        columns: ['id'],
        rows: [{ id: '1' }],
        rowCount: 1,
        truncated: false,
      });
    const { container } = render(<WindowsDatabaseWorkbench instance={instance} onRequest={onRequest} />);

    expect(await screen.findByText('appdb')).toBeInTheDocument();
    fireEvent.click(container.querySelector('[id$="-tab-query"]') as HTMLElement);
    fireEvent.change(screen.getByPlaceholderText(/SELECT/i), {
      target: { value: 'SELECT * FROM users' },
    });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: /执\s*行/ }));

    await waitFor(() => expect(onRequest).toHaveBeenCalledTimes(2));
    expect(onRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'runReadonlyQuery',
        rowLimit: 100,
      }),
    );
  });

  it('shows preview row actions without requiring edit mode', async () => {
    const onRequest = vi
      .fn()
      .mockResolvedValueOnce({ databases: ['appdb'] })
      .mockResolvedValueOnce({ tables: [{ schema: 'dbo', name: 'users' }] })
      .mockResolvedValueOnce({
        columns: [
          { name: 'id', dataType: 'int', nullable: false, key: 'PRI' },
          { name: 'email', dataType: 'varchar(255)', nullable: false },
        ],
      })
      .mockResolvedValueOnce({
        columns: ['id', 'email'],
        rows: [{ id: '7', email: 'old@example.com' }],
        rowCount: 1,
        truncated: false,
      });
    const onMutation = vi.fn();
    const { container } = render(
      <WindowsDatabaseWorkbench instance={mysqlWorkbenchInstance()} onRequest={onRequest} onMutation={onMutation} />,
    );

    expect(await screen.findByText('appdb')).toBeInTheDocument();
    fireEvent.click(screen.getByText('appdb'));
    fireEvent.click(await screen.findByText('users'));
    expect(await screen.findByText('id')).toBeInTheDocument();
    fireEvent.click(container.querySelector('[id$="-tab-preview"]') as HTMLElement);
    expect(await screen.findByText('old@example.com')).toBeInTheDocument();

    expect(screen.queryByRole('switch', { name: /编辑模式/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /新增行/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /复制/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /编辑/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /删除/ })).toBeInTheDocument();
  });

  it('submits a controlled row update and refreshes preview', async () => {
    const onRequest = vi
      .fn()
      .mockResolvedValueOnce({ databases: ['appdb'] })
      .mockResolvedValueOnce({ tables: [{ schema: 'dbo', name: 'users' }] })
      .mockResolvedValueOnce({
        columns: [
          { name: 'id', dataType: 'int', nullable: false, key: 'PRI' },
          { name: 'email', dataType: 'varchar(255)', nullable: false },
        ],
      })
      .mockResolvedValueOnce({
        columns: ['id', 'email'],
        rows: [{ id: '7', email: 'old@example.com' }],
        rowCount: 1,
        truncated: false,
      })
      .mockResolvedValueOnce({
        columns: [
          { name: 'id', dataType: 'int', nullable: false, key: 'PRI' },
          { name: 'email', dataType: 'varchar(255)', nullable: false },
        ],
      })
      .mockResolvedValueOnce({
        columns: ['id', 'email'],
        rows: [{ id: '7', email: 'new@example.com' }],
        rowCount: 1,
        truncated: false,
      });
    const onMutation = vi.fn().mockResolvedValueOnce({ affectedRows: 1, message: 'Row updated' });
    const { container } = render(
      <WindowsDatabaseWorkbench instance={mysqlWorkbenchInstance()} onRequest={onRequest} onMutation={onMutation} />,
    );

    expect(await screen.findByText('appdb')).toBeInTheDocument();
    fireEvent.click(screen.getByText('appdb'));
    fireEvent.click(await screen.findByText('users'));
    expect(await screen.findByText('id')).toBeInTheDocument();
    fireEvent.click(container.querySelector('[id$="-tab-preview"]') as HTMLElement);
    expect(await screen.findByText('old@example.com')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /编辑/ }));
    fireEvent.change(screen.getByLabelText('email'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() =>
      expect(onMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'updateRow',
          values: { email: 'new@example.com' },
          rowIdentity: { columns: [{ name: 'id', value: '7' }] },
        }),
      ),
    );
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();
  });

  it('disables edit and delete for rows without identity', async () => {
    const onRequest = vi
      .fn()
      .mockResolvedValueOnce({ databases: ['appdb'] })
      .mockResolvedValueOnce({ tables: [{ schema: 'dbo', name: 'logs' }] })
      .mockResolvedValueOnce({ columns: [{ name: 'message', dataType: 'text', nullable: false }] })
      .mockResolvedValueOnce({
        columns: ['message'],
        rows: [{ message: 'hello' }],
        rowCount: 1,
        truncated: false,
      });
    const { container } = render(
      <WindowsDatabaseWorkbench instance={mysqlWorkbenchInstance()} onRequest={onRequest} onMutation={vi.fn()} />,
    );

    expect(await screen.findByText('appdb')).toBeInTheDocument();
    fireEvent.click(screen.getByText('appdb'));
    fireEvent.click(await screen.findByText('logs'));
    expect(await screen.findByText('message')).toBeInTheDocument();
    fireEvent.click(container.querySelector('[id$="-tab-preview"]') as HTMLElement);
    expect(await screen.findByText('hello')).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: /编辑/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /删除/ })).toBeDisabled();
  });
});

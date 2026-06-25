# Windows Database Readonly Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows-only database detail workbench that lets analysts inspect database instances, browse databases/tables/columns, preview rows, and run bounded read-only queries without enabling write operations.

**Architecture:** Keep the current Windows `database` detection list in `ModuleDetail.tsx`, but stop using front-end shell string concatenation for detail access. Add a dedicated Tauri command that executes typed, read-only database actions for supported Windows engines and returns normalized JSON. Render the details in a focused React workbench component instead of growing the existing `ModuleDetail.tsx` database branch further.

**Tech Stack:** React 19 + Vite + Ant Design on the frontend, Tauri Rust commands on the backend, Vitest for frontend tests, Rust unit tests for command planning and read-only SQL guards.

---

## File Structure

- Create: `src/components/windows/WindowsDatabaseWorkbench.tsx`
  - Windows-only detail UI for database instances, object navigation, preview grid, and read-only query panel.
- Create: `src/components/windows/WindowsDatabaseWorkbench.test.tsx`
  - Component tests for loading, navigation, error states, and read-only query restrictions.
- Create: `src/modules/windowsDatabase/types.ts`
  - Shared frontend types for database instances, object trees, preview rows, and query results.
- Create: `src/modules/windowsDatabase/sql.ts`
  - Frontend helpers for query mode labels, row limits, and engine-specific UI formatting.
- Create: `src-tauri/src/windows_database.rs`
  - Dedicated Tauri command handler plus engine-specific action routing and read-only validation.
- Modify: `src-tauri/src/lib.rs`
  - Register the new Tauri command and add focused tests for the new command surface.
- Modify: `src/pages/ModuleDetail.tsx`
  - Open the Windows workbench from the `database` detection table, wire the new command, and move Windows detail state out of the generic Linux MySQL explorer path.
- Modify: `src/pages/ModuleDetail.windows.test.tsx`
  - Add integration tests for the new “查看详情” flow on Windows detection rows.
- Test: `src/components/windows/WindowsDatabaseWorkbench.test.tsx`
- Test: `src/pages/ModuleDetail.windows.test.tsx`
- Test: `src-tauri/src/windows_database.rs`

### Task 1: Define the Windows database detail contract

**Files:**
- Create: `src/modules/windowsDatabase/types.ts`
- Create: `src/modules/windowsDatabase/sql.ts`
- Test: `src/components/windows/WindowsDatabaseWorkbench.test.tsx`

- [ ] **Step 1: Write the failing type-driven component test**

```tsx
import { describe, expect, it } from 'vitest';
import type {
  WindowsDatabaseAction,
  WindowsDatabaseEngine,
  WindowsDatabaseInstance,
  WindowsDatabaseQueryRequest,
} from '../../modules/windowsDatabase/types';
import { getReadonlyQueryHint, getWindowsDatabaseDisplayName } from '../../modules/windowsDatabase/sql';

describe('windows database detail contract', () => {
  it('describes supported engines and readonly query hints', () => {
    const engines: WindowsDatabaseEngine[] = ['mysql', 'sqlserver', 'postgresql'];
    const actions: WindowsDatabaseAction[] = ['listDatabases', 'listTables', 'describeTable', 'previewTable', 'runReadonlyQuery'];

    const instance: WindowsDatabaseInstance = {
      id: 'mysql:MySQL80',
      engine: 'mysql',
      displayName: 'MySQL Server 8.0',
      source: '安装',
      status: '已安装',
      path: 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\',
      version: '8.0.36',
      host: 'localhost',
      port: 3306,
      credentialMode: 'detected',
      credentialLabel: 'Detected root credential',
    };

    const query: WindowsDatabaseQueryRequest = {
      engine: 'mysql',
      instanceId: instance.id,
      sql: 'SELECT id, email FROM users LIMIT 20',
      rowLimit: 20,
    };

    expect(engines).toHaveLength(3);
    expect(actions).toContain('runReadonlyQuery');
    expect(getWindowsDatabaseDisplayName(instance)).toContain('MySQL');
    expect(getReadonlyQueryHint(query.engine)).toMatch(/SELECT|SHOW|DESCRIBE/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/windows/WindowsDatabaseWorkbench.test.tsx -t "describes supported engines and readonly query hints"`

Expected: FAIL because `src/modules/windowsDatabase/types.ts` and `src/modules/windowsDatabase/sql.ts` do not exist yet.

- [ ] **Step 3: Write minimal shared types and helpers**

```ts
export type WindowsDatabaseEngine = 'mysql' | 'sqlserver' | 'postgresql';

export type WindowsDatabaseAction =
  | 'listDatabases'
  | 'listTables'
  | 'describeTable'
  | 'previewTable'
  | 'runReadonlyQuery';

export interface WindowsDatabaseInstance {
  id: string;
  engine: WindowsDatabaseEngine;
  displayName: string;
  source: string;
  status: string;
  path: string;
  version: string;
  host: string;
  port: number | null;
  credentialMode: 'detected' | 'manual' | 'unavailable';
  credentialLabel: string;
}

export interface WindowsDatabaseTableRef {
  catalog?: string;
  schema?: string;
  name: string;
}

export interface WindowsDatabaseColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  key?: string;
  defaultValue?: string;
  extra?: string;
}

export interface WindowsDatabasePreviewResult {
  columns: string[];
  rows: Record<string, string>[];
  rowCount: number;
  truncated: boolean;
}

export interface WindowsDatabaseQueryRequest {
  engine: WindowsDatabaseEngine;
  instanceId: string;
  sql: string;
  rowLimit: number;
}
```

```ts
import type { WindowsDatabaseEngine, WindowsDatabaseInstance } from './types';

export function getReadonlyQueryHint(engine: WindowsDatabaseEngine): string {
  switch (engine) {
    case 'mysql':
      return 'Only SELECT / SHOW / DESCRIBE / EXPLAIN queries are allowed.';
    case 'sqlserver':
      return 'Only SELECT / EXEC sp_help / EXEC sp_columns / EXEC sp_tables queries are allowed.';
    case 'postgresql':
      return 'Only SELECT / WITH / EXPLAIN queries are allowed.';
  }
}

export function getWindowsDatabaseDisplayName(instance: WindowsDatabaseInstance): string {
  const portSuffix = instance.port ? `:${instance.port}` : '';
  return `${instance.displayName}${portSuffix}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/windows/WindowsDatabaseWorkbench.test.tsx -t "describes supported engines and readonly query hints"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/modules/windowsDatabase/types.ts src/modules/windowsDatabase/sql.ts src/components/windows/WindowsDatabaseWorkbench.test.tsx
git commit -m "feat: define windows database readonly contract"
```

### Task 2: Add a dedicated Tauri read-only database command

**Files:**
- Create: `src-tauri/src/windows_database.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/windows_database.rs`

- [ ] **Step 1: Write the failing Rust tests for read-only SQL validation and action dispatch**

```rust
#[cfg(test)]
mod tests {
    use super::{build_engine_command, ensure_readonly_sql, DatabaseAction, DatabaseEngine};

    #[test]
    fn rejects_non_readonly_sql() {
        let err = ensure_readonly_sql(DatabaseEngine::Mysql, "DELETE FROM users").unwrap_err();
        assert!(err.contains("readonly"));
    }

    #[test]
    fn builds_mysql_preview_command() {
        let cmd = build_engine_command(
            DatabaseEngine::Mysql,
            DatabaseAction::PreviewTable,
            "mysql:MySQL80",
            Some("appdb"),
            Some("users"),
            None,
            50,
        ).unwrap();

        assert!(cmd.contains("SELECT *"));
        assert!(cmd.contains("LIMIT 50"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows_database`

Expected: FAIL because `src-tauri/src/windows_database.rs` is not defined or not imported.

- [ ] **Step 3: Implement the Tauri command module**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseEngine {
    Mysql,
    Sqlserver,
    Postgresql,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseAction {
    ListDatabases,
    ListTables,
    DescribeTable,
    PreviewTable,
    RunReadonlyQuery,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WindowsDatabaseRequest {
    pub engine: DatabaseEngine,
    pub action: DatabaseAction,
    pub instance_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub sql: Option<String>,
    pub row_limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowsDatabaseResponse {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

pub fn ensure_readonly_sql(engine: DatabaseEngine, sql: &str) -> Result<(), String> {
    let normalized = sql.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err("readonly query cannot be empty".into());
    }

    let denied = ["insert", "update", "delete", "drop", "alter", "truncate", "create", "grant", "revoke"];
    if denied.iter().any(|word| normalized.starts_with(word)) {
        return Err("readonly query rejected: only inspection statements are allowed".into());
    }

    let allowed = match engine {
        DatabaseEngine::Mysql => ["select", "show", "describe", "desc", "explain"].as_slice(),
        DatabaseEngine::Sqlserver => ["select", "exec sp_help", "exec sp_columns", "exec sp_tables", "with"].as_slice(),
        DatabaseEngine::Postgresql => ["select", "with", "explain"].as_slice(),
    };

    if allowed.iter().any(|prefix| normalized.starts_with(prefix)) {
        Ok(())
    } else {
        Err("readonly query rejected: unsupported statement".into())
    }
}
```

Add a `build_engine_command(...)` helper that produces PowerShell-friendly command strings for:
- MySQL: `mysql -e "..."`
- SQL Server: `sqlcmd -Q "..."`
- PostgreSQL: `psql -c "..."`

Add `#[tauri::command] async fn windows_database_readonly(...) -> WindowsDatabaseResponse` that:
- validates the action
- validates SQL for `RunReadonlyQuery`
- caps row limit to `100`
- runs the generated command with the same hidden-window strategy already used by `execute_local_command`

- [ ] **Step 4: Register the new command in Tauri**

Add the module import and handler entry in `src-tauri/src/lib.rs`:

```rust
mod windows_database;
use windows_database::windows_database_readonly;
```

```rust
.invoke_handler(tauri::generate_handler![
    get_system_info,
    run_scan,
    remote_connect,
    remote_open_terminal_session,
    remote_run_terminal_command,
    ssh_connect,
    ssh_execute,
    ssh_disconnect,
    ssh_is_connected,
    execute_local_command,
    windows_database_readonly,
    get_machine_info,
    verify_license,
    activate_license,
    check_license,
    deactivate_license
])
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows_database`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/windows_database.rs src-tauri/src/lib.rs
git commit -m "feat: add windows database readonly tauri command"
```

### Task 3: Add the Windows database detail workbench UI

**Files:**
- Create: `src/components/windows/WindowsDatabaseWorkbench.tsx`
- Create: `src/components/windows/WindowsDatabaseWorkbench.test.tsx`
- Modify: `src/pages/ModuleDetail.tsx`
- Test: `src/components/windows/WindowsDatabaseWorkbench.test.tsx`

- [ ] **Step 1: Write the failing component test for navigation and preview**

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WindowsDatabaseWorkbench from './WindowsDatabaseWorkbench';

describe('WindowsDatabaseWorkbench', () => {
  it('loads database list, table list, columns, and preview rows', async () => {
    const onRequest = vi
      .fn()
      .mockResolvedValueOnce({ databases: ['appdb'] })
      .mockResolvedValueOnce({ tables: [{ schema: 'dbo', name: 'users' }] })
      .mockResolvedValueOnce({ columns: [{ name: 'id', dataType: 'int', nullable: false }] })
      .mockResolvedValueOnce({ columns: ['id'], rows: [{ id: '1' }], rowCount: 1, truncated: false });

    render(
      <WindowsDatabaseWorkbench
        instance={{
          id: 'sqlserver:MSSQLSERVER',
          engine: 'sqlserver',
          displayName: 'SQL Server (MSSQLSERVER)',
          source: '服务',
          status: 'Running',
          path: 'C:\\Program Files\\Microsoft SQL Server',
          version: '16.0',
          host: 'localhost',
          port: 1433,
          credentialMode: 'manual',
          credentialLabel: 'Prompt for credentials',
        }}
        onRequest={onRequest}
      />
    );

    await waitFor(() => expect(screen.getByText('appdb')).toBeInTheDocument());
    fireEvent.click(screen.getByText('appdb'));
    await waitFor(() => expect(screen.getByText('users')).toBeInTheDocument());
    fireEvent.click(screen.getByText('users'));
    await waitFor(() => expect(screen.getByText('id')).toBeInTheDocument());
    expect(onRequest).toHaveBeenCalledTimes(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/windows/WindowsDatabaseWorkbench.test.tsx -t "loads database list, table list, columns, and preview rows"`

Expected: FAIL because `WindowsDatabaseWorkbench.tsx` does not exist.

- [ ] **Step 3: Implement the workbench component**

Build `WindowsDatabaseWorkbench.tsx` with:
- a compact header showing engine, host, port, and credential mode
- a left navigation column for databases and tables
- a right pane with three tabs:
  - `结构`
  - `数据预览`
  - `只读查询`
- props:

```tsx
interface WindowsDatabaseWorkbenchProps {
  instance: WindowsDatabaseInstance;
  onRequest: (request: {
    action: 'listDatabases' | 'listTables' | 'describeTable' | 'previewTable' | 'runReadonlyQuery';
    instanceId: string;
    engine: WindowsDatabaseEngine;
    database?: string;
    schema?: string;
    table?: string;
    sql?: string;
    rowLimit?: number;
  }) => Promise<any>;
}
```

Use stable layout constraints:
- fixed-width nav rail
- bounded table height
- result panel that does not shift when switching tabs

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/windows/WindowsDatabaseWorkbench.test.tsx -t "loads database list, table list, columns, and preview rows"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/windows/WindowsDatabaseWorkbench.tsx src/components/windows/WindowsDatabaseWorkbench.test.tsx
git commit -m "feat: add windows database readonly workbench ui"
```

### Task 4: Wire the workbench into the Windows database detection module

**Files:**
- Modify: `src/pages/ModuleDetail.tsx`
- Modify: `src/pages/ModuleDetail.windows.test.tsx`
- Test: `src/pages/ModuleDetail.windows.test.tsx`

- [ ] **Step 1: Write the failing integration test for the new detail action**

```tsx
it('opens a Windows database detail workbench from a detected database row', async () => {
  invokeMock.mockImplementation(async (command: string, args?: any) => {
    if (command === 'execute_local_command') {
      return {
        success: true,
        stdout: [
          '===DB_SERVICES===',
          JSON.stringify([
            {
              Name: 'MSSQLSERVER',
              DisplayName: 'SQL Server (MSSQLSERVER)',
              State: 'Running',
              PathName: 'C:\\Program Files\\Microsoft SQL Server',
              ProcessId: 1234,
            },
          ]),
          '===DB_PORTS===',
          '[]',
          '===DB_PROCESSES===',
          '[]',
          '===DB_INSTALLS===',
          '[]',
        ].join('\\n'),
        stderr: '',
      };
    }

    if (command === 'windows_database_readonly') {
      return { success: true, stdout: JSON.stringify({ databases: ['master'] }), stderr: '' };
    }

    throw new Error(`Unexpected command: ${command}`);
  });

  render(
    <ModuleDetail
      moduleKey="database"
      mode="local"
      osType="Windows"
      privilegeMode="none"
      sudoPassword=""
      isDarkMode={false}
      glassEnabled={false}
      wallpaper=""
    />
  );

  await waitFor(() => expect(screen.getByText('SQL Server (MSSQLSERVER)')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /查看详情/ }));
  await waitFor(() => expect(screen.getByText('master')).toBeInTheDocument());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/pages/ModuleDetail.windows.test.tsx -t "opens a Windows database detail workbench from a detected database row"`

Expected: FAIL because the detail action does not exist yet.

- [ ] **Step 3: Add detail action wiring in `ModuleDetail.tsx`**

Implement:
- Windows-only state for selected database instance and workbench visibility
- a `handleOpenWindowsDatabaseWorkbench(record)` helper that converts a detected row into `WindowsDatabaseInstance`
- a `requestWindowsDatabaseReadonly(request)` helper that calls:

```ts
const result = await invoke<{ success: boolean; stdout: string; stderr: string }>(
  'windows_database_readonly',
  { request }
);
```

- add an action column button for Windows `database` rows:

```tsx
<Button size="small" onClick={() => handleOpenWindowsDatabaseWorkbench(record)}>
  查看详情
</Button>
```

- render the workbench in a modal or drawer that is only used for `mode="local"` + `osType="Windows"`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/pages/ModuleDetail.windows.test.tsx -t "opens a Windows database detail workbench from a detected database row"`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/ModuleDetail.tsx src/pages/ModuleDetail.windows.test.tsx
git commit -m "feat: wire windows database detail workbench"
```

### Task 5: Add bounded read-only query UX and error handling

**Files:**
- Modify: `src/components/windows/WindowsDatabaseWorkbench.tsx`
- Modify: `src/components/windows/WindowsDatabaseWorkbench.test.tsx`
- Modify: `src-tauri/src/windows_database.rs`
- Test: `src/components/windows/WindowsDatabaseWorkbench.test.tsx`
- Test: `src-tauri/src/windows_database.rs`

- [ ] **Step 1: Write the failing tests for query guardrails**

```tsx
it('blocks non-readonly queries in the UI before sending them', async () => {
  const onRequest = vi.fn();
  render(<WindowsDatabaseWorkbench instance={instance} onRequest={onRequest} />);

  fireEvent.change(screen.getByPlaceholderText(/SELECT/i), {
    target: { value: 'DELETE FROM users' },
  });
  fireEvent.click(screen.getByRole('button', { name: /执行只读查询/ }));

  expect(onRequest).not.toHaveBeenCalled();
  expect(screen.getByText(/只允许只读查询/)).toBeInTheDocument();
});
```

```rust
#[test]
fn caps_preview_row_limit_to_100() {
    let cmd = build_engine_command(
        DatabaseEngine::Postgresql,
        DatabaseAction::PreviewTable,
        "postgresql:postgres",
        Some("appdb"),
        Some("users"),
        None,
        500,
    ).unwrap();

    assert!(cmd.contains("LIMIT 100"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/components/windows/WindowsDatabaseWorkbench.test.tsx -t "blocks non-readonly queries in the UI before sending them"`

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows_database`

Expected: FAIL because UI and backend caps are not implemented yet.

- [ ] **Step 3: Implement the guardrails**

In the UI:
- block empty SQL
- block obvious write prefixes
- show inline error message
- default row limit to `50`
- clamp UI row limit to `100`

In Rust:
- clamp preview/query row limits to `100`
- return explicit `stderr` messages for unsupported tools (`mysql`, `sqlcmd`, `psql` missing)
- keep the command surface read-only only

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/components/windows/WindowsDatabaseWorkbench.test.tsx`

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows_database`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/windows/WindowsDatabaseWorkbench.tsx src/components/windows/WindowsDatabaseWorkbench.test.tsx src-tauri/src/windows_database.rs
git commit -m "feat: add windows database readonly query guardrails"
```

### Task 6: Final verification

**Files:**
- Modify: none
- Test: `src/components/windows/WindowsDatabaseWorkbench.test.tsx`
- Test: `src/pages/ModuleDetail.windows.test.tsx`
- Test: `src-tauri/src/windows_database.rs`

- [ ] **Step 1: Run frontend database workbench tests**

Run: `npm test -- src/components/windows/WindowsDatabaseWorkbench.test.tsx`

Expected: PASS

- [ ] **Step 2: Run Windows module detail tests**

Run: `npm test -- src/pages/ModuleDetail.windows.test.tsx`

Expected: PASS

- [ ] **Step 3: Run Rust backend tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows_database`

Expected: PASS

- [ ] **Step 4: Run fast Rust compile verification**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: add windows database readonly workbench"
```

## Self-Review

- Spec coverage: this plan covers Windows-only readonly database exploration, dedicated backend command routing, bounded query execution, and UI integration. It intentionally excludes CRUD and non-Windows engines outside readonly support.
- Placeholder scan: no TBD/TODO placeholders remain; every task includes exact files, commands, and expected results.
- Type consistency: the same engine/action names are used across shared frontend types, the Tauri request contract, and the React workbench props.

# Windows Database Controlled CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Windows-only controlled single-row insert, update, and delete operations to the existing database workbench while keeping read-only mode as the default.

**Architecture:** Keep `windows_database_readonly` unchanged and add a separate `windows_database_mutation` Tauri command for structured writes. Add frontend mutation types/helpers, an opt-in edit mode in `WindowsDatabaseWorkbench`, and a dedicated row editor modal so arbitrary write SQL is never accepted from the UI.

**Tech Stack:** React 19, Ant Design 6, Vitest, Tauri 2, Rust, serde/serde_json.

---

## File Structure

- Modify: `src/modules/windowsDatabase/types.ts`
  - Add mutation request/response, row identity, and editable column types.
- Create: `src/modules/windowsDatabase/mutation.ts`
  - Frontend helpers for editable-column derivation, row identity extraction, required-field validation, and changed-value extraction.
- Create: `src/modules/windowsDatabase/mutation.test.ts`
  - Unit tests for frontend mutation helpers.
- Create: `src/components/windows/WindowsDatabaseRowEditor.tsx`
  - Focused modal form for insert/update row values.
- Create: `src/components/windows/WindowsDatabaseRowEditor.test.tsx`
  - Component tests for form validation and submit payloads.
- Modify: `src/components/windows/WindowsDatabaseWorkbench.tsx`
  - Add edit mode, add/edit/delete controls, mutation request dispatch, refresh-on-success, and disabled edit/delete behavior when no row identity is available.
- Modify: `src/components/windows/WindowsDatabaseWorkbench.test.tsx`
  - Add workbench behavior tests for controlled CRUD.
- Modify: `src-tauri/src/windows_database.rs`
  - Add mutation request types, SQL construction helpers, structured write command planning, and `windows_database_mutation`.
- Modify: `src-tauri/src/lib.rs`
  - Register `windows_database_mutation`.
- Modify: `src/pages/ModuleDetail.tsx`
  - Add `requestWindowsDatabaseMutation` and pass it to the workbench.
- Modify: `src/pages/ModuleDetail.windows.test.tsx`
  - Add integration coverage for mutation command wiring.

---

## Task 1: Add Frontend Mutation Contract and Helpers

**Files:**
- Modify: `src/modules/windowsDatabase/types.ts`
- Create: `src/modules/windowsDatabase/mutation.ts`
- Create: `src/modules/windowsDatabase/mutation.test.ts`

- [ ] **Step 1: Write failing helper tests**

Add `src/modules/windowsDatabase/mutation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { WindowsDatabaseColumn } from './types';
import {
  buildChangedWindowsDatabaseValues,
  buildWindowsDatabaseRowIdentity,
  getWindowsDatabaseEditableColumns,
  validateWindowsDatabaseRowValues,
} from './mutation';

const columns: WindowsDatabaseColumn[] = [
  { name: 'id', dataType: 'int', nullable: false, key: 'PRI', extra: 'auto_increment' },
  { name: 'email', dataType: 'varchar(255)', nullable: false },
  { name: 'nickname', dataType: 'varchar(255)', nullable: true },
  { name: 'created_at', dataType: 'timestamp', nullable: false, defaultValue: 'CURRENT_TIMESTAMP', extra: 'generated' },
];

describe('windows database mutation helpers', () => {
  it('derives editable columns without generated columns', () => {
    expect(getWindowsDatabaseEditableColumns(columns)).toStrictEqual([
      expect.objectContaining({ name: 'email', required: true, generated: false }),
      expect.objectContaining({ name: 'nickname', required: false, generated: false }),
    ]);
  });

  it('builds row identity from primary or unique columns', () => {
    expect(buildWindowsDatabaseRowIdentity(columns, { id: '7', email: 'a@example.com' })).toStrictEqual({
      columns: [{ name: 'id', value: '7' }],
    });
  });

  it('returns null identity when no primary or unique key is present', () => {
    expect(
      buildWindowsDatabaseRowIdentity(
        [{ name: 'email', dataType: 'varchar(255)', nullable: false }],
        { email: 'a@example.com' },
      ),
    ).toBeNull();
  });

  it('blocks empty required fields before insert or update submission', () => {
    expect(validateWindowsDatabaseRowValues(getWindowsDatabaseEditableColumns(columns), { email: '' })).toBe(
      '字段不能为空',
    );
    expect(validateWindowsDatabaseRowValues(getWindowsDatabaseEditableColumns(columns), { email: 'a@example.com' })).toBeNull();
  });

  it('sends only changed update values', () => {
    expect(
      buildChangedWindowsDatabaseValues(
        { email: 'old@example.com', nickname: 'old' },
        { email: 'new@example.com', nickname: 'old' },
      ),
    ).toStrictEqual({ email: 'new@example.com' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/modules/windowsDatabase/mutation.test.ts`

Expected: FAIL because `src/modules/windowsDatabase/mutation.ts` and mutation types do not exist.

- [ ] **Step 3: Add mutation types**

Append to `src/modules/windowsDatabase/types.ts`:

```ts
export type WindowsDatabaseMutationAction = 'insertRow' | 'updateRow' | 'deleteRow';

export interface WindowsDatabaseRowIdentity {
  columns: Array<{
    name: string;
    value: string | number | boolean | null;
  }>;
}

export interface WindowsDatabaseEditableColumn extends WindowsDatabaseColumn {
  required: boolean;
  generated: boolean;
  identity: boolean;
}

export interface WindowsDatabaseMutationRequest {
  engine: WindowsDatabaseEngine;
  action: WindowsDatabaseMutationAction;
  instanceId: string;
  database: string;
  schema?: string;
  table: string;
  values?: Record<string, string | number | boolean | null>;
  rowIdentity?: WindowsDatabaseRowIdentity;
  generatedColumns?: string[];
}

export interface WindowsDatabaseMutationResponse {
  affectedRows: number | null;
  message: string;
}
```

- [ ] **Step 4: Add helper implementation**

Create `src/modules/windowsDatabase/mutation.ts`:

```ts
import type {
  WindowsDatabaseColumn,
  WindowsDatabaseEditableColumn,
  WindowsDatabaseRowIdentity,
} from './types';

function isIdentityColumn(column: WindowsDatabaseColumn): boolean {
  const key = (column.key ?? '').toLowerCase();
  return key.includes('pri') || key.includes('primary') || key.includes('uni') || key.includes('unique');
}

function isGeneratedColumn(column: WindowsDatabaseColumn): boolean {
  const extra = `${column.extra ?? ''} ${column.defaultValue ?? ''}`.toLowerCase();
  return (
    extra.includes('auto_increment') ||
    extra.includes('identity') ||
    extra.includes('generated') ||
    extra.includes('rowguid')
  );
}

export function getWindowsDatabaseEditableColumns(columns: WindowsDatabaseColumn[]): WindowsDatabaseEditableColumn[] {
  return columns
    .map((column) => {
      const generated = isGeneratedColumn(column);
      const identity = isIdentityColumn(column);
      return {
        ...column,
        generated,
        identity,
        required: !column.nullable && !column.defaultValue && !generated,
      };
    })
    .filter((column) => !column.generated);
}

export function buildWindowsDatabaseRowIdentity(
  columns: WindowsDatabaseColumn[],
  row: Record<string, unknown>,
): WindowsDatabaseRowIdentity | null {
  const identityColumns = columns.filter(isIdentityColumn);
  if (identityColumns.length === 0) {
    return null;
  }

  const identity = identityColumns.flatMap((column) => {
    if (!(column.name in row)) {
      return [];
    }

    const value = row[column.name];
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return [{ name: column.name, value: value ?? null }];
    }

    return [{ name: column.name, value: String(value) }];
  });

  return identity.length === identityColumns.length ? { columns: identity } : null;
}

export function validateWindowsDatabaseRowValues(
  columns: WindowsDatabaseEditableColumn[],
  values: Record<string, unknown>,
): string | null {
  const missing = columns.find((column) => {
    const value = values[column.name];
    return column.required && (value == null || String(value).trim() === '');
  });

  return missing ? '字段不能为空' : null;
}

export function buildChangedWindowsDatabaseValues(
  original: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(next)
      .filter(([name, value]) => original[name] !== value)
      .map(([name, value]) => [name, normalizeMutationValue(value)]),
  );
}

export function normalizeMutationValue(value: unknown): string | number | boolean | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return String(value);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/modules/windowsDatabase/mutation.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/windowsDatabase/types.ts src/modules/windowsDatabase/mutation.ts src/modules/windowsDatabase/mutation.test.ts
git commit -m "feat: add windows database mutation helpers"
```

---

## Task 2: Add Backend Mutation Command Planning

**Files:**
- Modify: `src-tauri/src/windows_database.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing Rust tests**

Add tests in `src-tauri/src/windows_database.rs` inside the existing `#[cfg(test)] mod tests`:

```rust
#[test]
fn deserializes_mutation_request_from_camel_case_fields() {
    let request: WindowsDatabaseMutationRequest = serde_json::from_value(json!({
        "engine": "mysql",
        "action": "updateRow",
        "instanceId": "mysql:127.0.0.1:3306",
        "database": "appdb",
        "table": "users",
        "values": { "email": "new@example.com" },
        "rowIdentity": { "columns": [{ "name": "id", "value": "7" }] },
        "generatedColumns": ["id"]
    }))
    .unwrap();

    assert_eq!(request.instance_id, "mysql:127.0.0.1:3306");
    assert_eq!(request.generated_columns, Some(vec!["id".to_string()]));
}

#[test]
fn rejects_update_without_row_identity() {
    let request = mutation_request(DatabaseEngine::Mysql, DatabaseMutationAction::UpdateRow);
    let error = build_mutation_command_plan(&WindowsDatabaseMutationRequest {
        row_identity: None,
        ..request
    })
    .unwrap_err();

    assert!(error.contains("row identity"));
}

#[test]
fn builds_mysql_insert_with_escaped_literals() {
    let request = WindowsDatabaseMutationRequest {
        engine: DatabaseEngine::Mysql,
        action: DatabaseMutationAction::InsertRow,
        instance_id: "mysql:127.0.0.1:3306".to_string(),
        database: "appdb".to_string(),
        schema: None,
        table: "users".to_string(),
        values: Some(serde_json::json!({ "email": "o'reilly@example.com", "nickname": null })),
        row_identity: None,
        generated_columns: Some(vec!["id".to_string()]),
    };

    let plan = build_mutation_command_plan(&request).unwrap();
    let sql = plan.args.last().unwrap();

    assert!(sql.contains("INSERT INTO `users`"));
    assert!(sql.contains("'o''reilly@example.com'"));
    assert!(sql.contains("NULL"));
    assert!(!sql.contains("`id`"));
}

#[test]
fn builds_sqlserver_update_with_single_row_guard() {
    let request = WindowsDatabaseMutationRequest {
        engine: DatabaseEngine::Sqlserver,
        action: DatabaseMutationAction::UpdateRow,
        instance_id: "sqlserver:MSSQLSERVER".to_string(),
        database: "appdb".to_string(),
        schema: Some("dbo".to_string()),
        table: "users".to_string(),
        values: Some(serde_json::json!({ "email": "new@example.com" })),
        row_identity: Some(RowIdentity {
            columns: vec![RowIdentityColumn { name: "id".to_string(), value: serde_json::json!("7") }],
        }),
        generated_columns: None,
    };

    let plan = build_mutation_command_plan(&request).unwrap();
    let sql = plan.args.last().unwrap();

    assert!(sql.contains("UPDATE TOP (1) [dbo].[users]"));
    assert!(sql.contains("WHERE [id] = '7'"));
}

#[test]
fn builds_postgresql_delete_with_returning_guard() {
    let request = WindowsDatabaseMutationRequest {
        engine: DatabaseEngine::Postgresql,
        action: DatabaseMutationAction::DeleteRow,
        instance_id: "postgresql:127.0.0.1:5432".to_string(),
        database: "appdb".to_string(),
        schema: Some("public".to_string()),
        table: "users".to_string(),
        values: None,
        row_identity: Some(RowIdentity {
            columns: vec![RowIdentityColumn { name: "id".to_string(), value: serde_json::json!(7) }],
        }),
        generated_columns: None,
    };

    let plan = build_mutation_command_plan(&request).unwrap();
    let sql = plan.args.last().unwrap();

    assert!(sql.contains("WITH target AS"));
    assert!(sql.contains("DELETE FROM public.users"));
    assert!(sql.contains("RETURNING 1"));
}

#[test]
fn rejects_unsafe_identifier_in_mutation_request() {
    let error = build_mutation_command_plan(&WindowsDatabaseMutationRequest {
        table: "users; DROP TABLE users".to_string(),
        ..mutation_request(DatabaseEngine::Mysql, DatabaseMutationAction::InsertRow)
    })
    .unwrap_err();

    assert!(error.contains("identifier"));
}
```

Also add this helper in the same test module:

```rust
fn mutation_request(engine: DatabaseEngine, action: DatabaseMutationAction) -> WindowsDatabaseMutationRequest {
    WindowsDatabaseMutationRequest {
        engine,
        action,
        instance_id: match engine {
            DatabaseEngine::Mysql => "mysql:127.0.0.1:3306",
            DatabaseEngine::Sqlserver => "sqlserver:MSSQLSERVER",
            DatabaseEngine::Postgresql => "postgresql:127.0.0.1:5432",
        }
        .to_string(),
        database: "appdb".to_string(),
        schema: None,
        table: "users".to_string(),
        values: Some(serde_json::json!({ "email": "new@example.com" })),
        row_identity: Some(RowIdentity {
            columns: vec![RowIdentityColumn { name: "id".to_string(), value: serde_json::json!("7") }],
        }),
        generated_columns: None,
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows_database`

Expected: FAIL because mutation request/action types and `build_mutation_command_plan` do not exist.

- [ ] **Step 3: Implement mutation request types**

Add to `src-tauri/src/windows_database.rs` near the readonly request types:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DatabaseMutationAction {
    InsertRow,
    UpdateRow,
    DeleteRow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowIdentityColumn {
    pub name: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowIdentity {
    pub columns: Vec<RowIdentityColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsDatabaseMutationRequest {
    pub engine: DatabaseEngine,
    pub action: DatabaseMutationAction,
    pub instance_id: String,
    pub database: String,
    pub schema: Option<String>,
    pub table: String,
    pub values: Option<serde_json::Value>,
    pub row_identity: Option<RowIdentity>,
    pub generated_columns: Option<Vec<String>>,
}
```

- [ ] **Step 4: Implement mutation command planning**

Add helper functions in `src-tauri/src/windows_database.rs`:

```rust
fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
    {
        return Err("unsafe identifier".to_string());
    }
    Ok(())
}

fn values_object(value: &Option<serde_json::Value>) -> Result<Vec<(String, serde_json::Value)>, String> {
    let Some(serde_json::Value::Object(values)) = value else {
        return Err("values are required".to_string());
    };

    if values.is_empty() {
        return Err("values are required".to_string());
    }

    values
        .iter()
        .map(|(name, value)| {
            validate_identifier(name)?;
            Ok((name.clone(), value.clone()))
        })
        .collect()
}

fn filtered_values(
    values: &Option<serde_json::Value>,
    generated_columns: &Option<Vec<String>>,
) -> Result<Vec<(String, serde_json::Value)>, String> {
    let generated = generated_columns
        .as_ref()
        .map(|items| items.iter().map(|item| item.to_ascii_lowercase()).collect::<Vec<_>>())
        .unwrap_or_default();

    let filtered = values_object(values)?
        .into_iter()
        .filter(|(name, _)| !generated.iter().any(|generated_name| generated_name == &name.to_ascii_lowercase()))
        .collect::<Vec<_>>();

    if filtered.is_empty() {
        return Err("values are required".to_string());
    }

    Ok(filtered)
}

fn render_sql_literal(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(value) => {
            if *value { "1".to_string() } else { "0".to_string() }
        }
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => format!("'{}'", escape_sql_literal(value)),
        other => format!("'{}'", escape_sql_literal(&other.to_string())),
    }
}

fn mutation_where_clause(engine: DatabaseEngine, identity: &RowIdentity) -> Result<String, String> {
    if identity.columns.is_empty() {
        return Err("row identity is required".to_string());
    }

    identity
        .columns
        .iter()
        .map(|column| {
            validate_identifier(&column.name)?;
            let name = quote_identifier(engine, &column.name);
            Ok(format!("{} = {}", name, render_sql_literal(&column.value)))
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|parts| parts.join(" AND "))
}

fn quote_identifier(engine: DatabaseEngine, value: &str) -> String {
    match engine {
        DatabaseEngine::Mysql => format!("`{}`", escape_mysql_identifier(value)),
        DatabaseEngine::Sqlserver => format!("[{}]", escape_sqlserver_identifier(value)),
        DatabaseEngine::Postgresql => escape_psql_identifier(value),
    }
}

fn build_mutation_sql(request: &WindowsDatabaseMutationRequest) -> Result<String, String> {
    validate_identifier(&request.database)?;
    validate_identifier(&request.table)?;
    if let Some(schema) = request.schema.as_deref() {
        validate_identifier(schema)?;
    }

    let schema = request.schema.as_deref().unwrap_or(match request.engine {
        DatabaseEngine::Sqlserver => "dbo",
        DatabaseEngine::Postgresql => "public",
        DatabaseEngine::Mysql => "",
    });
    let table = match request.engine {
        DatabaseEngine::Mysql => quote_identifier(request.engine, &request.table),
        DatabaseEngine::Sqlserver => format!("{}.{}", quote_identifier(request.engine, schema), quote_identifier(request.engine, &request.table)),
        DatabaseEngine::Postgresql => format!("{}.{}", quote_identifier(request.engine, schema), quote_identifier(request.engine, &request.table)),
    };

    match request.action {
        DatabaseMutationAction::InsertRow => {
            let values = filtered_values(&request.values, &request.generated_columns)?;
            let columns = values
                .iter()
                .map(|(name, _)| quote_identifier(request.engine, name))
                .collect::<Vec<_>>()
                .join(", ");
            let literals = values
                .iter()
                .map(|(_, value)| render_sql_literal(value))
                .collect::<Vec<_>>()
                .join(", ");
            Ok(format!("INSERT INTO {} ({}) VALUES ({});", table, columns, literals))
        }
        DatabaseMutationAction::UpdateRow => {
            let identity = request.row_identity.as_ref().ok_or_else(|| "row identity is required".to_string())?;
            let values = filtered_values(&request.values, &request.generated_columns)?;
            let assignments = values
                .iter()
                .map(|(name, value)| Ok(format!("{} = {}", quote_identifier(request.engine, name), render_sql_literal(value))))
                .collect::<Result<Vec<_>, String>>()?
                .join(", ");
            let where_clause = mutation_where_clause(request.engine, identity)?;
            match request.engine {
                DatabaseEngine::Mysql => Ok(format!("UPDATE {} SET {} WHERE {} LIMIT 1;", table, assignments, where_clause)),
                DatabaseEngine::Sqlserver => Ok(format!("UPDATE TOP (1) {} SET {} WHERE {};", table, assignments, where_clause)),
                DatabaseEngine::Postgresql => Ok(format!(
                    "WITH target AS (SELECT 1 FROM {} WHERE {} LIMIT 1) UPDATE {} SET {} WHERE {} RETURNING 1;",
                    table, where_clause, table, assignments, where_clause
                )),
            }
        }
        DatabaseMutationAction::DeleteRow => {
            let identity = request.row_identity.as_ref().ok_or_else(|| "row identity is required".to_string())?;
            let where_clause = mutation_where_clause(request.engine, identity)?;
            match request.engine {
                DatabaseEngine::Mysql => Ok(format!("DELETE FROM {} WHERE {} LIMIT 1;", table, where_clause)),
                DatabaseEngine::Sqlserver => Ok(format!("DELETE TOP (1) FROM {} WHERE {};", table, where_clause)),
                DatabaseEngine::Postgresql => Ok(format!(
                    "WITH target AS (SELECT 1 FROM {} WHERE {} LIMIT 1) DELETE FROM {} WHERE {} RETURNING 1;",
                    table, where_clause, table, where_clause
                )),
            }
        }
    }
}

fn build_mutation_command_plan(request: &WindowsDatabaseMutationRequest) -> Result<DatabaseCommandPlan, String> {
    let sql = build_mutation_sql(request)?;
    let instance_target = parse_instance_target(request.engine, &request.instance_id)?;
    Ok(match request.engine {
        DatabaseEngine::Mysql => DatabaseCommandPlan {
            program: "mysql".to_string(),
            args: build_mysql_args(instance_target, &request.database, &sql),
        },
        DatabaseEngine::Sqlserver => DatabaseCommandPlan {
            program: "sqlcmd".to_string(),
            args: build_sqlserver_args(&sqlserver_server_arg(instance_target), &request.database, &sql),
        },
        DatabaseEngine::Postgresql => DatabaseCommandPlan {
            program: "psql".to_string(),
            args: build_postgresql_args(instance_target, &request.database, &sql),
        },
    })
}
```

- [ ] **Step 5: Add Tauri command and registration**

Add command in `src-tauri/src/windows_database.rs`:

```rust
#[tauri::command]
pub async fn windows_database_mutation(request: WindowsDatabaseMutationRequest) -> CommandResult {
    let plan = match build_mutation_command_plan(&request) {
        Ok(plan) => plan,
        Err(err) => return command_error(&err),
    };

    run_local_process(&plan.program, &plan.args)
}
```

Modify `src-tauri/src/lib.rs` to register it:

```rust
windows_database::windows_database_mutation,
```

in the existing `tauri::generate_handler![...]` list next to `windows_database_readonly`.

- [ ] **Step 6: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows_database`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/windows_database.rs src-tauri/src/lib.rs
git commit -m "feat: add windows database controlled mutation command"
```

---

## Task 3: Add Row Editor Component

**Files:**
- Create: `src/components/windows/WindowsDatabaseRowEditor.tsx`
- Create: `src/components/windows/WindowsDatabaseRowEditor.test.tsx`

- [ ] **Step 1: Write failing editor tests**

Create `src/components/windows/WindowsDatabaseRowEditor.test.tsx`:

```tsx
/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { WindowsDatabaseEditableColumn } from '../../modules/windowsDatabase/types';
import { WindowsDatabaseRowEditor } from './WindowsDatabaseRowEditor';

beforeAll(() => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/windows/WindowsDatabaseRowEditor.test.tsx`

Expected: FAIL because `WindowsDatabaseRowEditor.tsx` does not exist.

- [ ] **Step 3: Implement row editor**

Create `src/components/windows/WindowsDatabaseRowEditor.tsx`:

```tsx
import { Alert, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { WindowsDatabaseEditableColumn } from '../../modules/windowsDatabase/types';
import { normalizeMutationValue, validateWindowsDatabaseRowValues } from '../../modules/windowsDatabase/mutation';

const { Text } = Typography;

interface WindowsDatabaseRowEditorProps {
  open: boolean;
  mode: 'insert' | 'update';
  columns: WindowsDatabaseEditableColumn[];
  initialValues: Record<string, unknown>;
  onCancel: () => void;
  onSubmit: (values: Record<string, string | number | boolean | null>) => void;
}

export function WindowsDatabaseRowEditor({
  open,
  mode,
  columns,
  initialValues,
  onCancel,
  onSubmit,
}: WindowsDatabaseRowEditorProps) {
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValues(initialValues);
      setError(null);
    }
  }, [initialValues, open]);

  const handleSubmit = () => {
    const validationError = validateWindowsDatabaseRowValues(columns, values);
    if (validationError) {
      setError(validationError);
      return;
    }

    onSubmit(
      Object.fromEntries(
        columns
          .filter((column) => mode === 'insert' || !column.identity)
          .map((column) => [column.name, normalizeMutationValue(values[column.name])]),
      ),
    );
  };

  return (
    <Modal
      open={open}
      title={mode === 'insert' ? '新增行' : '编辑行'}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          取消
        </Button>,
        <Button key="save" type="primary" onClick={handleSubmit}>
          保存
        </Button>,
      ]}
      width={640}
      destroyOnHidden
    >
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        {error ? <Alert type="error" title={error} showIcon /> : null}
        <Form layout="vertical">
          {columns.map((column) => (
            <Form.Item
              key={column.name}
              label={column.name}
              required={column.required}
              extra={
                <Text type="secondary">
                  {column.dataType}
                  {column.nullable ? ' nullable' : ' not null'}
                </Text>
              }
            >
              <Input
                aria-label={column.name}
                value={values[column.name] == null ? '' : String(values[column.name])}
                disabled={mode === 'update' && column.identity}
                onChange={(event) => {
                  setError(null);
                  setValues((current) => ({ ...current, [column.name]: event.target.value }));
                }}
              />
            </Form.Item>
          ))}
        </Form>
      </Space>
    </Modal>
  );
}

export default WindowsDatabaseRowEditor;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/windows/WindowsDatabaseRowEditor.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/windows/WindowsDatabaseRowEditor.tsx src/components/windows/WindowsDatabaseRowEditor.test.tsx
git commit -m "feat: add windows database row editor"
```

---

## Task 4: Add Workbench Edit Mode and Mutation Flow

**Files:**
- Modify: `src/components/windows/WindowsDatabaseWorkbench.tsx`
- Modify: `src/components/windows/WindowsDatabaseWorkbench.test.tsx`

- [ ] **Step 1: Write failing Workbench CRUD tests**

Append tests to `src/components/windows/WindowsDatabaseWorkbench.test.tsx`. Add this helper near the top of the file before the new tests:

```tsx
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
```

Then add these tests:

```tsx
it('keeps controlled CRUD disabled until edit mode is enabled', async () => {
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
  fireEvent.click(container.querySelector('[id$="-tab-preview"]') as HTMLElement);

  expect(screen.queryByRole('button', { name: /新增行/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('switch', { name: /编辑模式/ }));
  expect(screen.getByRole('button', { name: /新增行/ })).toBeInTheDocument();
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
  fireEvent.click(container.querySelector('[id$="-tab-preview"]') as HTMLElement);
  fireEvent.click(screen.getByRole('switch', { name: /编辑模式/ }));
  fireEvent.click(await screen.findByRole('button', { name: /编辑/ }));
  fireEvent.change(screen.getByLabelText('email'), { target: { value: 'new@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: /保存/ }));

  await waitFor(() => expect(onMutation).toHaveBeenCalledWith(expect.objectContaining({
    action: 'updateRow',
    values: { email: 'new@example.com' },
    rowIdentity: { columns: [{ name: 'id', value: '7' }] },
  })));
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
  fireEvent.click(container.querySelector('[id$="-tab-preview"]') as HTMLElement);
  fireEvent.click(screen.getByRole('switch', { name: /编辑模式/ }));

  expect(await screen.findByRole('button', { name: /编辑/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /删除/ })).toBeDisabled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/components/windows/WindowsDatabaseWorkbench.test.tsx -t "controlled"`

Expected: FAIL because `onMutation`, edit mode, and row actions do not exist.

- [ ] **Step 3: Extend Workbench props**

Modify `WindowsDatabaseWorkbenchProps` in `src/components/windows/WindowsDatabaseWorkbench.tsx`:

```ts
interface WindowsDatabaseWorkbenchProps {
  instance: WindowsDatabaseInstance;
  onRequest: (request: WindowsDatabaseReadonlyRequest) => Promise<any>;
  onMutation?: (request: WindowsDatabaseMutationRequest) => Promise<WindowsDatabaseMutationResponse>;
}
```

Import the new mutation types and helpers:

```ts
import {
  buildChangedWindowsDatabaseValues,
  buildWindowsDatabaseRowIdentity,
  getWindowsDatabaseEditableColumns,
} from '../../modules/windowsDatabase/mutation';
import type {
  WindowsDatabaseMutationRequest,
  WindowsDatabaseMutationResponse,
} from '../../modules/windowsDatabase/types';
import WindowsDatabaseRowEditor from './WindowsDatabaseRowEditor';
```

- [ ] **Step 4: Add edit-mode state and refresh helper**

Add state:

```ts
const [editMode, setEditMode] = useState(false);
const [rowEditorOpen, setRowEditorOpen] = useState(false);
const [rowEditorMode, setRowEditorMode] = useState<'insert' | 'update'>('insert');
const [editingRow, setEditingRow] = useState<Record<string, unknown> | null>(null);
const [mutationLoading, setMutationLoading] = useState(false);
const [mutationError, setMutationError] = useState<string | null>(null);
const [mutationSuccess, setMutationSuccess] = useState<string | null>(null);
```

Extract preview refresh from `handleTableSelect` into:

```ts
const loadSelectedTableDetails = async (table: WindowsDatabaseTableRef, database: string) => {
  const [columnResponse, previewResponse] = await Promise.all([
    onRequest({ action: 'describeTable', instanceId: instance.id, engine: instance.engine, database, schema: table.schema, table: table.name }),
    onRequest({ action: 'previewTable', instanceId: instance.id, engine: instance.engine, database, schema: table.schema, table: table.name, rowLimit }),
  ]);
  setColumns(normalizeColumns((columnResponse as { columns?: unknown })?.columns));
  setPreviewResult(normalizeResult(previewResponse));
};
```

Then call this helper from `handleTableSelect` and after successful mutation.

- [ ] **Step 5: Add mutation handlers**

Add handlers:

```ts
const editableColumns = useMemo(() => getWindowsDatabaseEditableColumns(columns), [columns]);

const openInsertEditor = () => {
  setRowEditorMode('insert');
  setEditingRow(null);
  setMutationError(null);
  setRowEditorOpen(true);
};

const openUpdateEditor = (row: Record<string, unknown>) => {
  setRowEditorMode('update');
  setEditingRow(row);
  setMutationError(null);
  setRowEditorOpen(true);
};

const submitRowMutation = async (values: Record<string, string | number | boolean | null>) => {
  if (!onMutation || !selectedDatabase || !selectedTable) {
    return;
  }

  const rowIdentity =
    rowEditorMode === 'update' && editingRow
      ? buildWindowsDatabaseRowIdentity(columns, editingRow)
      : undefined;
  const requestValues =
    rowEditorMode === 'update' && editingRow
      ? buildChangedWindowsDatabaseValues(editingRow, values)
      : values;

  const request: WindowsDatabaseMutationRequest = {
    action: rowEditorMode === 'insert' ? 'insertRow' : 'updateRow',
    engine: instance.engine,
    instanceId: instance.id,
    database: selectedDatabase,
    schema: selectedTable.schema,
    table: selectedTable.name,
    values: requestValues,
    rowIdentity: rowIdentity ?? undefined,
    generatedColumns: columns.filter((column) => `${column.extra ?? ''}`.toLowerCase().includes('generated')).map((column) => column.name),
  };

  setMutationLoading(true);
  setMutationError(null);
  try {
    const response = await onMutation(request);
    setMutationSuccess(response.message);
    setRowEditorOpen(false);
    await loadSelectedTableDetails(selectedTable, selectedDatabase);
  } catch (error) {
    setMutationError(error instanceof Error ? error.message : '写入失败，未修改数据');
  } finally {
    setMutationLoading(false);
  }
};
```

Add delete handler using `Modal.confirm` or `Popconfirm`:

```ts
const deleteRow = async (row: Record<string, unknown>) => {
  if (!onMutation || !selectedDatabase || !selectedTable) return;
  const rowIdentity = buildWindowsDatabaseRowIdentity(columns, row);
  if (!rowIdentity) {
    setMutationError('当前表缺少主键或唯一键，不能编辑或删除行');
    return;
  }
  setMutationLoading(true);
  try {
    const response = await onMutation({
      action: 'deleteRow',
      engine: instance.engine,
      instanceId: instance.id,
      database: selectedDatabase,
      schema: selectedTable.schema,
      table: selectedTable.name,
      rowIdentity,
    });
    setMutationSuccess(response.message);
    await loadSelectedTableDetails(selectedTable, selectedDatabase);
  } catch (error) {
    setMutationError(error instanceof Error ? error.message : '写入失败，未修改数据');
  } finally {
    setMutationLoading(false);
  }
};
```

- [ ] **Step 6: Render edit controls in preview tab**

In the preview tab toolbar, add:

```tsx
<Switch
  size="small"
  checked={editMode}
  onChange={setEditMode}
  aria-label="编辑模式"
/>
{editMode ? (
  <Button size="small" type="primary" onClick={openInsertEditor} disabled={!selectedTable || !onMutation}>
    新增行
  </Button>
) : null}
```

Append an action column to preview table columns when edit mode is enabled:

```ts
const previewActionColumn = editMode
  ? [{
      title: '操作',
      key: '__actions',
      fixed: 'right' as const,
      width: 140,
      render: (_: unknown, row: Record<string, unknown>) => {
        const identity = buildWindowsDatabaseRowIdentity(columns, row);
        return (
          <Space size={6}>
            <Button size="small" disabled={!identity || mutationLoading} onClick={() => openUpdateEditor(row)}>
              编辑
            </Button>
            <Popconfirm
              title="确认删除这一行？"
              onConfirm={() => void deleteRow(row)}
              disabled={!identity || mutationLoading}
            >
              <Button size="small" danger disabled={!identity || mutationLoading}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    }]
  : [];
```

Use `columns={[...previewColumns, ...previewActionColumn]}` for the preview table.

Render the row editor once near the end of the component:

```tsx
<WindowsDatabaseRowEditor
  open={rowEditorOpen}
  mode={rowEditorMode}
  columns={editableColumns}
  initialValues={editingRow ?? {}}
  onCancel={() => setRowEditorOpen(false)}
  onSubmit={(values) => void submitRowMutation(values)}
/>
```

- [ ] **Step 7: Run Workbench tests**

Run: `npm test -- src/components/windows/WindowsDatabaseWorkbench.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/windows/WindowsDatabaseWorkbench.tsx src/components/windows/WindowsDatabaseWorkbench.test.tsx
git commit -m "feat: add windows database edit mode"
```

---

## Task 5: Wire Mutation Command Through ModuleDetail

**Files:**
- Modify: `src/pages/ModuleDetail.tsx`
- Modify: `src/pages/ModuleDetail.windows.test.tsx`

- [ ] **Step 1: Write failing integration test**

Add to `src/pages/ModuleDetail.windows.test.tsx`:

```tsx
it('routes Windows database controlled mutations through the dedicated command', async () => {
  (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
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
              StartMode: 'Auto',
              PathName: 'C:\\Program Files\\Microsoft SQL Server\\MSSQL16.MSSQLSERVER\\MSSQL\\Binn\\sqlservr.exe',
              ProcessId: 1234,
            },
          ]),
          '===DB_PORTS===',
          '[]',
          '===DB_PROCESSES===',
          '[]',
          '===DB_INSTALLS===',
          '[]',
        ].join('\n'),
        stderr: '',
      };
    }

    if (command === 'windows_database_readonly') {
      const action = args?.request?.action;
      if (action === 'listDatabases') return { success: true, stdout: JSON.stringify({ databases: ['appdb'] }), stderr: '' };
      if (action === 'listTables') return { success: true, stdout: JSON.stringify({ tables: [{ schema: 'dbo', name: 'users' }] }), stderr: '' };
      if (action === 'describeTable') {
        return {
          success: true,
          stdout: JSON.stringify({ columns: [
            { name: 'id', dataType: 'int', nullable: false, key: 'PRI' },
            { name: 'email', dataType: 'varchar(255)', nullable: false },
          ] }),
          stderr: '',
        };
      }
      if (action === 'previewTable') {
        return {
          success: true,
          stdout: JSON.stringify({ columns: ['id', 'email'], rows: [{ id: '7', email: 'new@example.com' }], rowCount: 1, truncated: false }),
          stderr: '',
        };
      }
    }

    if (command === 'windows_database_mutation') {
      expect(args?.request).toEqual(expect.objectContaining({ action: 'updateRow' }));
      return { success: true, stdout: JSON.stringify({ affectedRows: 1, message: 'Row updated' }), stderr: '' };
    }

    throw new Error(`Unexpected command: ${command}`);
  });

  renderWindowsModule('database');

  await waitFor(() => expect(screen.getByText('SQL Server (MSSQLSERVER)')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /查看详情/ }));
  expect(await screen.findByText('appdb')).toBeInTheDocument();
  fireEvent.click(screen.getByText('appdb'));
  fireEvent.click(await screen.findByText('users'));
  fireEvent.click(document.querySelector('[id$="-tab-preview"]') as HTMLElement);
  fireEvent.click(screen.getByRole('switch', { name: /编辑模式/ }));
  fireEvent.click(await screen.findByRole('button', { name: /编辑/ }));
  fireEvent.change(screen.getByLabelText('email'), { target: { value: 'new@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: /保存/ }));

  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('windows_database_mutation', expect.anything()));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/pages/ModuleDetail.windows.test.tsx -t "routes Windows database controlled mutations"`

Expected: FAIL because `ModuleDetail` does not pass `onMutation`.

- [ ] **Step 3: Add mutation request helper in `ModuleDetail.tsx`**

Import type:

```ts
import type { WindowsDatabaseMutationRequest, WindowsDatabaseMutationResponse } from '../modules/windowsDatabase/types';
```

Add command result type near readonly result type:

```ts
type WindowsDatabaseMutationCommandResult = {
  success: boolean;
  stdout: string;
  stderr: string;
};
```

Add helper:

```ts
const requestWindowsDatabaseMutation = useCallback(async (request: WindowsDatabaseMutationRequest): Promise<WindowsDatabaseMutationResponse> => {
  const result = await invoke<WindowsDatabaseMutationCommandResult>('windows_database_mutation', { request });
  if (!result.success) {
    throw new Error(result.stderr || '写入失败，未修改数据');
  }

  if (!result.stdout.trim()) {
    return { affectedRows: null, message: '写入完成' };
  }

  try {
    const parsed = JSON.parse(result.stdout) as Partial<WindowsDatabaseMutationResponse>;
    return {
      affectedRows: typeof parsed.affectedRows === 'number' ? parsed.affectedRows : null,
      message: parsed.message || '写入完成',
    };
  } catch {
    return { affectedRows: null, message: result.stdout.trim() || '写入完成' };
  }
}, []);
```

Pass to workbench:

```tsx
<WindowsDatabaseWorkbench
  instance={selectedWindowsDatabaseInstance}
  onRequest={requestWindowsDatabaseReadonly}
  onMutation={requestWindowsDatabaseMutation}
/>
```

- [ ] **Step 4: Run integration test**

Run: `npm test -- src/pages/ModuleDetail.windows.test.tsx -t "routes Windows database controlled mutations"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/ModuleDetail.tsx src/pages/ModuleDetail.windows.test.tsx
git commit -m "feat: wire windows database mutation command"
```

---

## Task 6: Final Verification and Push

**Files:**
- Modify: none

- [ ] **Step 1: Run frontend mutation helper tests**

Run: `npm test -- src/modules/windowsDatabase/mutation.test.ts`

Expected: PASS.

- [ ] **Step 2: Run row editor tests**

Run: `npm test -- src/components/windows/WindowsDatabaseRowEditor.test.tsx`

Expected: PASS.

- [ ] **Step 3: Run workbench tests**

Run: `npm test -- src/components/windows/WindowsDatabaseWorkbench.test.tsx`

Expected: PASS.

- [ ] **Step 4: Run Windows page integration tests**

Run: `npm test -- src/pages/ModuleDetail.windows.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run Rust mutation tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml windows_database`

Expected: PASS.

- [ ] **Step 6: Run Rust compile check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS. Existing unused warnings are acceptable if the exit code is 0.

- [ ] **Step 7: Run frontend build**

Run: `npm run build`

Expected: PASS. Existing Vite chunk-size warnings are acceptable if the exit code is 0.

- [ ] **Step 8: Inspect git state**

Run: `git status --short --branch`

Expected: clean working tree on `main`, ahead of `origin/main`.

- [ ] **Step 9: Push**

Run:

```bash
git push origin main
```

Expected: push succeeds and `main` matches `origin/main`.

## Self-Review

- Spec coverage: the plan covers structured mutation types, backend command separation, frontend edit mode, confirmation/disabled behavior, ModuleDetail wiring, and full verification.
- Placeholder scan: no TODO/TBD placeholders are present; every task has concrete files, commands, and expected results.
- Type consistency: frontend uses `WindowsDatabaseMutationRequest` / `WindowsDatabaseMutationResponse`; backend uses `WindowsDatabaseMutationRequest` and `DatabaseMutationAction`; action values match `insertRow`, `updateRow`, and `deleteRow`.

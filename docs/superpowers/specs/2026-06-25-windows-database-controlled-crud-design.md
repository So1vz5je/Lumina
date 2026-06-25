# Windows Database Controlled CRUD Design

## Goal

Add a Windows-only controlled database editing mode to the existing database workbench so analysts can inspect table data and perform bounded single-row create, update, and delete operations without enabling arbitrary write SQL.

## Current Context

The current Windows database workbench is read-only. It discovers supported Windows database instances, lists databases and tables, describes table columns, previews bounded rows, and runs guarded read-only queries through the `windows_database_readonly` Tauri command. Read-only query protection exists in both the React workbench and the Rust command layer.

CRUD must not reuse the read-only query text area. Write operations need a separate command contract, UI mode, and backend validation so the app can control the table, columns, primary key conditions, and maximum affected rows.

## Approaches Considered

### Recommended: Controlled Single-Row CRUD

The workbench adds an explicit edit mode. Users can add a row through a generated form, edit one selected preview row, or delete one selected preview row. Update and delete require a primary key or unique row identity from the preview payload. The backend builds engine-specific SQL from structured requests and rejects operations that could affect multiple rows.

This is the safest first version because the app controls the mutation shape and can enforce single-row constraints on both sides.

### Alternative: Raw Write SQL Editor

The query tab could add a "write mode" that accepts `INSERT`, `UPDATE`, and `DELETE`. This is faster to build but unsafe for this app because a typo can modify many rows, and meaningful validation of arbitrary write SQL across SQL Server, MySQL, and PostgreSQL is brittle.

This is explicitly out of scope for the first CRUD version.

### Alternative: Generated SQL Preview Only

The app could generate copyable SQL for the user to run elsewhere. This avoids direct write risk but does not satisfy the requested in-app add, delete, update workflow.

## Feature Scope

Version 1 supports:

- Supported engines: SQL Server, MySQL, PostgreSQL.
- Supported operations: insert one row, update one row, delete one row.
- UI location: existing `WindowsDatabaseWorkbench` data preview area.
- Write activation: explicit edit mode toggle.
- Confirmation: update and delete show a confirmation dialog before sending the mutation.
- Refresh: successful mutation refreshes the current table preview.
- Safety: update and delete require a row identity built from primary key or unique key columns.
- Result feedback: show success/error inline in the workbench.

Version 1 does not support:

- Arbitrary write SQL input.
- Batch update/delete.
- Schema changes such as `ALTER TABLE`.
- Transaction scripting.
- Editing tables without a usable row identity, except inserting a new row.
- Remote Linux database editing.

## UI Design

The existing workbench remains read-only by default. In the preview tab, add an `edit mode` switch in the table toolbar. When disabled, the preview grid behaves as it does today.

When edit mode is enabled:

- Add a primary toolbar action: `add row`.
- Add row actions: `edit` and `delete`.
- If the selected table has no usable row identity, row edit/delete actions are disabled with a tooltip explaining that a primary key or unique key is required.
- `add row` opens a compact modal form generated from the table column metadata.
- `edit` opens the same form prefilled from the selected row and locks identity fields.
- `delete` opens a confirmation dialog showing the target table and identity fields.

Form behavior:

- Column names, data types, nullable state, default values, key metadata, and extra metadata are displayed in a dense form.
- Auto-increment or generated columns are not required for insert and are hidden or read-only when the backend marks them as generated.
- Empty nullable fields submit as `NULL`.
- Empty non-null fields without defaults are blocked in the UI before request submission.

## Frontend Data Model

Add mutation-oriented frontend types under `src/modules/windowsDatabase/types.ts`:

- `WindowsDatabaseMutationAction`: `insertRow | updateRow | deleteRow`
- `WindowsDatabaseMutationRequest`
- `WindowsDatabaseMutationResponse`
- `WindowsDatabaseRowIdentity`
- `WindowsDatabaseEditableColumn`

The workbench should derive editable columns from the existing `WindowsDatabaseColumn` payload where possible. If backend column metadata is incomplete for an engine, the frontend still renders the form but only enforces generic required/nullable rules.

## Backend Command Design

Add a new Tauri command:

```rust
windows_database_mutation(request: WindowsDatabaseMutationRequest) -> CommandResult
```

The new command is separate from `windows_database_readonly`.

The request contains:

- engine
- action
- instance ID
- database
- schema
- table
- values for insert/update
- row identity for update/delete

The backend builds SQL internally. It rejects:

- unsupported engines or actions
- missing database/table
- missing row identity for update/delete
- update/delete requests without at least one changed value
- attempts to mutate generated identity columns
- identifiers that do not pass strict identifier validation
- mutation plans that do not include an engine-specific single-row guard

Engine-specific guards:

- MySQL: `UPDATE ... WHERE pk = ... LIMIT 1`, `DELETE ... WHERE pk = ... LIMIT 1`
- PostgreSQL: use a CTE or `ctid`-free primary-key condition with `RETURNING`, then verify at most one affected row where possible
- SQL Server: `UPDATE TOP (1) ... WHERE pk = ...`, `DELETE TOP (1) ... WHERE pk = ...`

The backend returns normalized JSON in stdout:

```json
{
  "success": true,
  "affectedRows": 1,
  "message": "Row updated"
}
```

If the database client cannot report affected rows reliably, the backend still constrains the command shape to one row and reports `affectedRows: null`.

## SQL Construction Rules

Do not concatenate raw user SQL. The backend may render SQL literals from structured values, but all identifiers and literals must pass helpers with focused tests:

- identifier quoting per engine
- literal escaping per engine
- null handling
- boolean/number/string rendering
- generated-column exclusion
- primary-key `WHERE` construction

If a value cannot be represented safely, reject the request with an explicit error.

## Error Handling

The UI shows mutation errors inline in the preview tab and leaves edit mode enabled so the user can correct values.

Expected errors include these semantic cases. Final UI copy should follow the existing Chinese UI style:

- selected table has no primary key or unique key, so edit/delete is disabled
- a required field is empty
- mutation request is missing row identity
- database client tool is unavailable
- mutation failed and no data was changed

The backend should return `success: false` with a precise `stderr` message and must not fall back to raw SQL execution.

## Testing

Frontend tests:

- edit mode is disabled by default
- enabling edit mode exposes add/edit/delete controls
- tables without row identity disable edit/delete
- insert form blocks required empty fields
- update sends only changed values plus row identity
- delete requires confirmation before request
- successful mutation refreshes preview

Rust tests:

- mutation request deserializes from camelCase fields
- insert command escapes literals and excludes generated columns
- update requires row identity
- delete requires row identity
- update/delete plans include one-row guard
- unsafe identifiers are rejected
- missing table/database is rejected

Integration test:

- a detected Windows database row opens the workbench, loads table preview, toggles edit mode, submits a controlled mutation, and refreshes preview.

## Rollout

Keep the default user journey read-only. The edit mode should be visibly opt-in and only scoped to Windows local database instances. If a mutation command fails because the required database CLI is unavailable, surface the exact missing tool message and leave existing read-only browsing unaffected.

## Non-Goals

This design does not attempt to build a full SQL client. It adds a narrow incident-response convenience for controlled edits during local Windows analysis.

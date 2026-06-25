# Windows Local Analysis Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows local analysis modules render usable data, remove dead local flows, and connect scan/results pages to real scan output.

**Architecture:** Keep the existing `ModuleDetail`-driven local command model, but normalize Windows parsing and presentation so each module produces table or list data consistently. Reuse the existing Rust `run_scan` backend for batch scan output, store those results in shared frontend state, and render the same data in `Results` instead of mock data.

**Tech Stack:** React 19, TypeScript, Ant Design, Tauri invoke API, Vitest, Rust/Tauri backend

---

### Task 1: Add scan result state and page tests

**Files:**
- Create: `src/pages/Scan.test.tsx`
- Create: `src/pages/Results.test.tsx`
- Modify: `src/pages/Scan.tsx`
- Modify: `src/pages/Results.tsx`

- [ ] Write failing tests for `Scan` storing real `run_scan` results and `Results` rendering provided results instead of mock data.
- [ ] Run: `npm test -- src/pages/Scan.test.tsx src/pages/Results.test.tsx`
- [ ] Implement minimal shared result flow using props or lifted state that keeps `Scan` and `Results` connected.
- [ ] Re-run: `npm test -- src/pages/Scan.test.tsx src/pages/Results.test.tsx`

### Task 2: Remove dead Windows local user-trace path

**Files:**
- Modify: `src/pages/UserTrace.tsx`
- Test: `src/pages/Scan.test.tsx`

- [ ] Replace the nonexistent `get_local_user_trace` path with a clear local Windows placeholder sourced from existing supported modules.
- [ ] Verify the component no longer references nonexistent Tauri commands.
- [ ] Re-run targeted tests covering local Windows rendering.

### Task 3: Add focused parsing coverage for broken Windows renderers

**Files:**
- Create: `src/pages/moduleDetailWindowsParsers.test.ts`
- Modify: `src/pages/ModuleDetail.tsx`

- [ ] Extract or expose minimal Windows parsing helpers for event logs and structured PowerShell output.
- [ ] Write failing tests for:
- [ ] Windows event log rows carrying `message` text into the displayed field.
- [ ] Empty JSON responses producing a user-facing fallback row rather than a blank panel.
- [ ] Registry/persistence section parsing preserving section names and details.
- [ ] Run: `npm test -- src/pages/moduleDetailWindowsParsers.test.ts`

### Task 4: Repair Windows local module data normalization

**Files:**
- Modify: `src/pages/ModuleDetail.tsx`

- [ ] Normalize parsed row shapes for Windows local modules so table columns and parser keys match.
- [ ] Fix event log rendering to populate the same key the columns read.
- [ ] Improve empty/error states for modules that require admin privileges or return no data.
- [ ] Keep the existing command inventory, but make output handling consistent across `user_list`, `logged_users`, `service_list`, `startup`, `cron`, `installed_software`, `network_conn`, `listen_ports`, `registry`, `win_defender`, `browser`, `recent_files`, and `process_anomaly`.
- [ ] Re-run targeted tests after each parser change.

### Task 5: Polish scan and result presentation

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/pages/Results.tsx`
- Modify: `src/pages/Scan.tsx`

- [ ] Lift real scan results into app-level state or a small shared state container.
- [ ] Route `Scan` completion to the results view with real returned data.
- [ ] Replace the raw JSON-only `Results` detail view with a readable summary plus formatted details, while still allowing JSON export.
- [ ] Keep the changes scoped to scan/results usability rather than full app redesign.

### Task 6: Fix TypeScript build blockers and verify

**Files:**
- Modify: `src/components/remote/FileManagerPane.tsx`
- Modify: `src/modules/remote/remoteWorkspaceReducer.ts`

- [ ] Replace `at` and `replaceAll` usage with equivalents compatible with the current TypeScript target.
- [ ] Run: `npm test`
- [ ] Run: `npm run build`
- [ ] Run: `cargo check --manifest-path src-tauri/Cargo.toml`
- [ ] Review output for any remaining Windows-analysis-specific regressions and report them explicitly.

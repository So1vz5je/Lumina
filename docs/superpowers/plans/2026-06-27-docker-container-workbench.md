# Docker Container Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add container-level Docker inspection, preview, read-only command execution, and confirmed advanced execution to the existing Docker module.

**Architecture:** Keep the feature in `ModuleDetail.tsx` because existing Docker parsing and modals already live there. Add small local helpers for command generation and execution routing, then expose actions through the existing Docker row action menu.

**Tech Stack:** React 19, Ant Design, Vitest, Tauri `invoke` commands `execute_local_command` and `ssh_execute`.

---

### Task 1: Lock Local Docker Actions With Tests

**Files:**
- Modify: `src/pages/moduleDetailWindowsParsers.test.tsx`

- [ ] **Step 1: Add a failing test**

Add a test that renders Windows local `docker` output, opens the row action menu, clicks a read-only command, verifies `execute_local_command` receives a `docker exec` command, then opens advanced execution and verifies confirmation is required before invoking the custom command.

- [ ] **Step 2: Run the focused test**

Run: `npx vitest run src/pages/moduleDetailWindowsParsers.test.tsx`

Expected: FAIL because the UI does not yet expose the new read-only and advanced execution controls.

### Task 2: Add Docker Command Helpers

**Files:**
- Modify: `src/pages/ModuleDetail.tsx`

- [ ] **Step 1: Implement helpers**

Add helper functions near existing Docker functions:

```ts
const quoteDockerArg = (value: string) => `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`;
const buildDockerShellCommand = (containerId: string, command: string) =>
  `docker exec ${quoteDockerArg(containerId)} sh -lc ${quoteDockerArg(command)} 2>&1`;
```

Use the existing `executeRemoteCommand` wrapper so local Windows mode continues routing through `execute_local_command`.

- [ ] **Step 2: Run focused test**

Run: `npx vitest run src/pages/moduleDetailWindowsParsers.test.tsx`

Expected: still FAIL until UI controls are wired.

### Task 3: Wire Read-Only And Advanced UI

**Files:**
- Modify: `src/pages/ModuleDetail.tsx`

- [ ] **Step 1: Add state**

Add selected container, advanced command input, and advanced modal state.

- [ ] **Step 2: Extend Docker action menu**

Expose `详情`, `日志`, `文件`, `只读检查`, and `高级执行`. Remove default start/stop/restart actions from the menu.

- [ ] **Step 3: Add modal content**

Render a compact modal with read-only buttons and a text area for advanced execution. Use `Modal.confirm` before executing the custom command.

- [ ] **Step 4: Run focused test**

Run: `npx vitest run src/pages/moduleDetailWindowsParsers.test.tsx`

Expected: PASS.

### Task 4: Verify Build

**Files:**
- No new files.

- [ ] **Step 1: Run full frontend build**

Run: `npm run build`

Expected: exit 0. Existing Vite chunk-size warnings are acceptable.


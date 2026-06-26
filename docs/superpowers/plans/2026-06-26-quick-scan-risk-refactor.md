# Quick Scan Risk Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn quick scan from a module batch runner into a high-risk-first incident response scan path.

**Architecture:** Keep the existing Tauri analyzer modules, but return a scan payload containing module results, risk findings, and diagnostics. Enhance Windows file scanning with web root evidence derived from panel detection, and keep the React results page as the display layer.

**Tech Stack:** React 19, Vitest, Tauri 2, Rust, serde_json.

---

### Task 1: Scan Payload Contract

**Files:**
- Modify: `src/types/analysis.ts`
- Modify: `src/pages/Scan.tsx`
- Modify: `src/App.tsx`
- Modify: `src/pages/Results.tsx`
- Test: `src/pages/Scan.test.tsx`
- Test: `src/pages/Results.test.tsx`

- [ ] Add a `ScanRunPayload` contract with `moduleResults`, `riskFindings`, and `diagnostics`.
- [ ] Update `Scan` to normalize both the new payload and legacy array responses.
- [ ] Update `App` to store risk findings separately from module results.
- [ ] Update `Results` to display backend risk findings merged with frontend fallback attribution.
- [ ] Verify with `npx vitest run --no-cache src/pages/Scan.test.tsx src/pages/Results.test.tsx`.

### Task 2: Windows File Scan Evidence

**Files:**
- Modify: `src-tauri/src/analyzer/windows/file_scan.rs`
- Modify: `src-tauri/src/analyzer/mod.rs`
- Test: Rust unit tests in the same modules

- [ ] Add web root aware file findings with suspicious script detection.
- [ ] Run panel detection before `file_scan` when both modules are selected, and pass discovered site roots into file scanning.
- [ ] Keep temp directory collection as existing behavior.
- [ ] Verify with `cargo test --manifest-path src-tauri/Cargo.toml file_scan`.

### Task 3: Backend Risk Findings

**Files:**
- Create: `src-tauri/src/analyzer/risk.rs`
- Modify: `src-tauri/src/analyzer/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: Rust unit tests in `risk.rs`

- [ ] Build backend risk findings from module results, prioritizing webshell correlation and process-network correlation.
- [ ] Return `ScanRunPayload` from the `run_scan` Tauri command.
- [ ] Preserve frontend fallback for older array-shaped responses.
- [ ] Verify with `cargo check --manifest-path src-tauri/Cargo.toml`.

### Task 4: Scan State Correctness

**Files:**
- Modify: `src/pages/Scan.tsx`
- Test: `src/pages/Scan.test.tsx`

- [ ] Prevent stale scan completion from updating the UI after the user stops the scan.
- [ ] Make the stop action honest by ignoring the pending result and showing a stopped state.
- [ ] Verify with the scan page tests.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Lumina Emergency Analyzer** is a cross-platform desktop security analysis tool built with Tauri 2, React 19, and Rust. It performs emergency response and forensics analysis on both local Windows systems and remote Linux/Unix hosts via SSH. The app supports two operational modes:

- **Local mode**: Runs Windows-specific analyzers (processes, persistence, network, security events, file scans) using PowerShell commands and WMI queries
- **Remote mode**: Connects to Linux/Unix systems via SSH, executes remote commands for analysis, and provides file management and terminal access

## Architecture

### Frontend (React 19 + TypeScript)

**Entry and routing**: `App.tsx` (~900 lines) orchestrates the entire UI flow:
- Mode selection (local vs remote) via `ModeSelect.tsx`
- After mode selection, renders a sidebar menu + content area layout
- Menu items are dynamically built based on OS type (Windows vs Linux) and mode
- Content area routes to specific pages based on `currentModule` state

**Module detail engine**: `ModuleDetail.tsx` (~9400 lines) is the core analysis rendering engine:
- Takes a `moduleKey` prop (e.g., `'system_info'`, `'network_conn'`, `'startup'`)
- Builds and executes commands (local PowerShell or remote SSH) based on mode and OS type
- Parses command output into structured data (tables, lists, JSON)
- Renders results in Ant Design tables/cards with export, search, and filtering
- Contains Windows-specific parsers for registry keys, event logs, persistence checks, and security events
- Contains Linux-specific parsers for systemd, cron, logs, and package management
- Each module knows its privilege requirements and shows appropriate warnings

**Remote workspace**: State managed via React Context + useReducer pattern:
- `RemoteWorkspaceProvider.tsx` wraps the app in remote state context
- `remoteWorkspaceReducer.ts` manages connections, terminal tabs, file browser state, and transfer queue
- `RemoteWorkspace.tsx` orchestrates three panes: file manager, terminal, transfer queue
- File transfers are tracked as state machines (queued → running → completed/failed/cancelled)

**Saved connections**: `savedConnections.ts` provides localStorage-backed connection persistence with encryption support (currently stores plaintext passwords).

### Backend (Rust + Tauri)

**Command wiring**: `lib.rs` (~800 lines) defines all Tauri commands:
- System info: `get_system_info()` using `sysinfo` crate
- Analysis: `run_scan()` dispatches to all Windows analyzer modules
- SSH: `ssh_connect()`, `ssh_execute()`, `ssh_disconnect()` for legacy terminal flow
- Remote workspace: `remote_connect()`, `remote_open_terminal_session()`, `remote_run_terminal_command()` for multi-connection remote management
- Local commands: `execute_local_command()` wraps PowerShell/cmd.exe with UTF-8 encoding
- License: `verify_license()`, `activate_license()`, `check_license()`, `deactivate_license()`

**SSH client**: `ssh.rs` wraps `ssh2` crate:
- Supports password and private key authentication
- Executes commands and returns stdout/stderr/exit_code
- Detects remote OS type (Windows/Linux/macOS) by probing system commands

**Connection management**: `remote/` module provides multi-connection state:
- `connection_manager.rs`: Tracks active SSH connections, stores `Arc<SshClient>` per connection
- `terminal_manager.rs`: Maps terminal sessions to connections, manages session lifecycle
- `sftp_manager.rs`: Handles SFTP file operations (browse, upload, download) per connection
- When a connection errors or disconnects, all its terminal sessions are automatically closed

**Windows analyzers**: `analyzer/windows/` contains 12 specialized modules:
- Each module implements the `Analyzer` trait (`name()`, `run()` returning `AnalysisResult`)
- Modules execute PowerShell/WMI commands synchronously (wrapped in `tokio::spawn_blocking`)
- Results return JSON in the `details` field, structured per module type
- Key modules: `system_info`, `network`, `process`, `startup`, `cron`, `persistence`, `file_scan`, `database`, `panel`, `security_events`, `user_trace`, `docker`

**License system**: `license.rs` (~400 lines) implements offline Ed25519-signed licenses:
- Generates machine ID from CPU ID + MAC address + hostname
- Verifies base64-encoded license keys against embedded public key
- Stores activated licenses in OS-specific app data directory
- License format: `{machine_id, expire_date, features, user_name}` + XOR obfuscation + signature

## Development Workflow

### Building and running

```bash
npm install                     # Install frontend dependencies
npm run dev                     # Run Vite dev server (frontend only)
npm run tauri dev              # Launch full desktop app with hot reload
npm run build                   # TypeScript compilation + Vite build
npm test                        # Run Vitest suite
cargo check --manifest-path src-tauri/Cargo.toml   # Rust validation
cargo fmt --manifest-path src-tauri/Cargo.toml     # Format Rust code
```

### Testing

- Frontend tests use Vitest + Testing Library + jsdom
- Test files are colocated as `*.test.tsx` or `*.test.ts` next to source files
- Setup file: `src/test/setup.ts` (imports `@testing-library/jest-dom`)
- Run single test file: `npm test -- path/to/file.test.tsx`
- No Rust unit tests currently exist except in `lib.rs` and parsers

### Key patterns

**Tauri command invocation from frontend**:
```typescript
import { invoke } from '@tauri-apps/api/core';

const result = await invoke<SystemInfo>('get_system_info');
const scanResults = await invoke<AnalysisResult[]>('run_scan');
const cmdResult = await invoke<CommandResult>('ssh_execute', { command: 'ls -la' });
```

**Adding a new analyzer module**:
1. Create `src-tauri/src/analyzer/windows/new_module.rs`
2. Implement `Analyzer` trait with `name()` and `run()`
3. Export in `src-tauri/src/analyzer/windows/mod.rs`
4. Add to `windows_analyzer_runners()` vec in `src-tauri/src/analyzer/mod.rs`
5. Add menu item in `buildWindowsMenuItems()` in `App.tsx`
6. Add case in `ModuleDetail.tsx` to handle the new `moduleKey`

**Remote workspace dispatch pattern**:
```typescript
const { state, dispatch } = useRemoteWorkspace();

// Connect to remote
dispatch({ type: 'connection/connected', payload: connectionRecord });

// Switch active connection
dispatch({ type: 'connection/activated', payload: { connectionId } });

// Open terminal tab
dispatch({ type: 'terminal/opened', payload: terminalTab });

// Append output
dispatch({ type: 'terminal/lineAppended', payload: { terminalTabId, line } });
```

## Important Constraints

### Windows command execution

- All local commands run through `execute_local_command` Tauri command
- PowerShell commands are wrapped with UTF-8 encoding setup: `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8`
- Commands starting with `powershell`, `pwsh`, or `cmd` are passed to `cmd /C` instead of PowerShell
- Windows handles are hidden via `CREATE_NO_WINDOW` flag

### Remote command execution

- Remote commands go through `ssh_execute` (legacy single-connection) or `remote_run_terminal_command` (multi-connection)
- Outputs are returned as `{ stdout, stderr, exit_code }`
- SSH errors mark the connection as errored and close all associated terminal sessions
- No PTY/interactive shell support; each command is one-shot execution

### Module detail data flow

`ModuleDetail` expects parsers to produce arrays of row objects where keys match table column `dataIndex` values. Common pattern:
```typescript
const data = parseOutput(stdout).map((row, index) => ({ key: index, ...row }));
return <Table columns={columns} dataSource={data} />;
```

When adding new modules, match this pattern for consistency.

### License activation

- License keys are base64-encoded payloads with Ed25519 signatures
- Verification is offline-only (no network calls)
- Activated licenses persist to `{app_data_dir}/Lumina/license.dat`
- License generation tool: `license-gen/` (separate Cargo workspace)
- Private key for signing: `license-gen/private.key` (never commit to git)

## Known Issues

- `ModuleDetail.tsx` contains some Windows parsers that don't align column keys with parsed data keys (see `docs/superpowers/plans/2026-05-26-windows-local-analysis-fixes.md`)
- Saved connection passwords are stored in plaintext in localStorage (marked for encryption in future)
- No automated tests for Rust analyzer modules
- TypeScript target is ES2020 but some code uses ES2022+ features (`.at()`, `.replaceAll()`) causing compatibility warnings

## Code Style

**TypeScript/React**:
- 2-space indentation, semicolons required
- PascalCase for components and files: `RemoteWorkspace.tsx`
- camelCase for variables, functions, types: `moduleKey`, `executeCommand`
- Functional components with hooks (no class components)
- Props typed explicitly with interfaces
- Avoid `any`; use `unknown` for unparsed JSON

**Rust**:
- snake_case for modules, functions, variables: `get_system_info`, `analyzer/windows/`
- Tauri commands are snake_case: `remote_connect`, `execute_local_command`
- Run `cargo fmt` before committing
- Use `log::info!()` / `log::warn!()` / `log::error!()` for backend logging

## Git and Deployment

Prefer Conventional Commit format: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`.

Build outputs:
- Frontend: `dist/` (generated by Vite)
- Rust: `src-tauri/target/` (Cargo build artifacts)
- Tauri: `src-tauri/target/release/bundle/` (platform-specific installers)

Tauri command schemas are auto-generated to `src-tauri/gen/schemas/`.

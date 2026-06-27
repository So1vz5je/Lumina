# Docker Container Workbench Design

## Goal

Enhance the Docker container analysis module so an analyst can inspect a container, preview logs and files, run safe read-only checks, and optionally execute an advanced command after confirmation.

## Scope

The feature applies to the existing `docker` module in `src/pages/ModuleDetail.tsx`. It must work in both Windows local analysis and remote Linux analysis by routing commands through the existing execution path:

- Windows local: `execute_local_command`
- Remote Linux: `ssh_execute`

The first implementation focuses on container-level actions. Docker image analysis remains a read-only inventory table.

## User Experience

Each real container row gets an action menu:

- Inspect: runs `docker inspect <container>` and shows structured JSON.
- Logs: runs `docker logs --tail 200 <container>` and opens the existing text preview modal.
- Files: lists a directory inside the container and lets users preview text files with a bounded command.
- Read-only commands: offers preset incident-response commands such as process list, network sockets, users, environment, listening paths, and recent file changes.
- Advanced execution: allows a custom command only after a confirmation prompt. The UI explains that it can change container state.

The module should not expose start, stop, or restart actions in the default action menu.

## Command Model

Commands are generated with a small Docker command helper. It quotes the container ID and shell command, uses a shell fallback order of `/bin/sh`, `/bin/bash`, and `/bin/ash`, applies output limits where practical, and avoids interactive TTY flags.

Read-only presets are explicit strings owned by the UI. Advanced execution accepts user input, wraps it in the same shell fallback, and requires confirmation.

## Error Handling

Failures should show the command output or error text in the UI without crashing the module. File previews are bounded to avoid huge output. Empty output should render as an empty result with the command recorded.

## Tests

Add focused Vitest coverage in `src/pages/moduleDetailWindowsParsers.test.tsx` or the closest existing ModuleDetail tests:

- Docker container rows expose local inspect/log/read-only/custom execution actions.
- Read-only command uses `execute_local_command` for Windows local mode.
- Advanced command prompts for confirmation before invoking.
- Service/install pseudo rows do not expose container actions.


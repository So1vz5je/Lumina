# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the React 19 + Vite frontend. Keep top-level app wiring in `src/App.tsx`, feature screens in `src/pages/`, shared remote UI in `src/components/remote/`, and state/types for remote workflows in `src/modules/remote/`. Static assets live in `src/assets/` and `public/`. Frontend tests are colocated as `*.test.tsx`, with shared test setup in `src/test/setup.ts`.

`src-tauri/src/` contains the Rust desktop backend. Keep Tauri command wiring in `lib.rs`, app entrypoints in `main.rs`, license and SSH logic in `license.rs` and `ssh.rs`, remote session code under `src-tauri/src/remote/`, and Windows analyzers under `src-tauri/src/analyzer/windows/`. `license-gen/` is a separate Rust utility plus support scripts. Treat `dist/`, `src-tauri/target/`, and `src-tauri/gen/schemas/` as generated output.

## Build, Test, and Development Commands
`npm install` installs frontend dependencies.
`npm run dev` starts the Vite frontend.
`npm run tauri dev` launches the desktop app locally.
`npm run build` runs TypeScript compilation and produces the frontend bundle.
`npm test` runs the Vitest suite once.
`cargo check --manifest-path src-tauri/Cargo.toml` validates Rust changes quickly.
`cargo run --manifest-path license-gen/Cargo.toml` runs the license generator utility.

## Coding Style & Naming Conventions
Follow the style already used in touched files. In TypeScript and TSX, use 2-space indentation, semicolons, typed props/results, and PascalCase component filenames such as `RemoteWorkspace.tsx`. Use camelCase for variables and helpers. In Rust, prefer snake_case for modules, files, and Tauri command names such as `saved_connections` or `user_trace`. Run `cargo fmt --manifest-path src-tauri/Cargo.toml` after Rust edits.

## Testing Guidelines
Use Vitest for frontend tests and colocate them as `*.test.tsx` beside the feature or module they cover. For Rust logic, add focused `#[cfg(test)]` unit tests next to the module when practical. Before opening a PR, run `npm test`, `npm run build`, and `cargo check --manifest-path src-tauri/Cargo.toml`.

## Commit & Pull Request Guidelines
This checkout does not include `.git` history, so commit conventions could not be verified from local logs. Prefer short, imperative Conventional Commit subjects such as `feat: add remote transfer conflict dialog` or `fix: guard SSH reconnect`. Keep PRs focused, summarize affected flows, list verification commands, link the related task, and include screenshots for UI changes.

## Security & Configuration Tips
Do not commit credentials, generated analyzer output, or sample license data. Treat `license-gen/private.key` as sensitive and never paste it into issues, docs, or logs.

# Repository Guidelines

## Project Structure & Module Organization

- `client/` — Vite + React UI (TS/TSX). Outputs to `dist/client`.
- `server/` — Hono HTTP API (Node/TS). Outputs to `dist/server`.
- `src/` — Electron entry points (`main.ts`, `preload.ts`).
- `shared/` — Shared types/utilities consumed by client and server.
- `cli/` — Programmatic MCP testing CLI.
- `assets/`, `scripts/`, `bin/` — Icons, build helpers, startup scripts.
- `dist/`, `out/` — Build artifacts (do not edit).

## Build, Test, and Development Commands

- `npm run install:deps` — Install client and server dependencies.
- `npm run dev` — Run server and client in watch mode.
- `npm run build` — Build client and server bundles to `dist/`.
- `npm start` — Start production server via `bin/start.js` (auto‑picks a free port). Example: `PORT=6274 npm start`.
- `npm run test` — Run unit tests with Vitest.
- `npm run test:e2e` — Run Playwright end‑to‑end tests.
- Electron: `npm run electron:start`, `electron:make`, `electron:package`.
- Docker: `docker:build`, `docker:run`, `docker:up`, `docker:down`.

## Coding Style & Naming Conventions

- Language: TypeScript. Prefer named exports. 2‑space indentation.
- Run `npm run prettier-fix` before pushing.
- React: functional components, files `PascalCase.tsx` in `client/src/components/`.
- Modules/utilities: `kebab-case.ts`. Types/interfaces `PascalCase`.
- Imports: client supports `@/...` alias; server uses relative paths.

## Testing Guidelines

- Frameworks: Vitest (unit), Playwright (e2e).
- Co‑locate tests next to source: `*.test.ts`/`*.test.tsx`.
- Aim to cover data transforms, hooks, and server routes.
- Keep tests deterministic; avoid network calls unless mocked.

## Commit & Pull Request Guidelines

- Commits: concise, imperative subject; include scope when helpful.
  - Examples: `server: add health endpoint`, `client: fix connection modal`, `build: update forge config`.
- PRs: include purpose, linked issues, clear testing notes, and screenshots for UI changes.
- Keep PRs focused and small; update docs when behavior or commands change.

## Security & Configuration Tips

- Do not commit secrets. Use environment variables locally and CI.
- Common env vars: `PORT`, `MCP_SERVER_COMMAND`, `MCP_SERVER_ARGS`.
  - Example: `MCP_SERVER_COMMAND="npx" MCP_SERVER_ARGS='["my-mcp", "--flag"]' npm start`.
- Docker image exposes port 3001; configure `PORT` as needed.

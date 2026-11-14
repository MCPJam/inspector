# Inspector-specific instructions

- In server code, use `logger` from `@/utils/logger`, never `console.*`.
  In route catch blocks, use `reportRouteFailure` from `server/utils/route-error-report.ts`.
  `logger.error` sends errors to Sentry; warn/info/debug do not. See
  `docs/server-error-reporting.md` for classification and capture policy.
- `bin/start.js` uses its existing logging helpers. Browser console debugging
  is allowed. Never log credentials or access tokens.
- Tests live beside source in `__tests__/`. Reuse `client/src/test/factories.ts`,
  `client/src/test/mocks/`, and `server/routes/mcp/__tests__/helpers/`.
- For tests that depend on WorkOS behavior, use
  `server/test/support/workos-emulator.ts`. See the WorkOS contract tests
  section in `../CONTRIBUTING.md`.
- After editing `server/services/browserd/daemon/` or anything it imports
  (including `protocol.ts` and WebMCP launch flags), run
  `npm run bundle:browserd -w @mcpjam/inspector` and commit both files in
  `server/services/browserd/dist/`. The sandbox runs this bundle without rebuilding it.
  Playwright version bumps follow `docs/chromium-bump-checklist.md`; rebundling
  does not cover them.
- Eval prompts must discover workspace data or establish fixtures before
  using them. Keep cases focused on the server behavior being tested and
  preserve required discovery steps and prerequisites.

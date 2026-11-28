# Inspector-specific instructions

- `client/`, `server/` and `shared/` each have an `AGENTS.md` with that layer's
  import rules and the check behind each rule. Read it before editing there.
- In server code, use `logger` from `@/utils/logger`, never `console.*`.
  In route catch blocks, use `reportRouteFailure` from `server/utils/route-error-report.ts`.
  `logger.error` sends errors to Sentry; warn/info/debug do not. See
  `docs/server-error-reporting.md` for classification and capture policy.
- `bin/start.js` uses its existing logging helpers. Browser console debugging
  is allowed. Never log credentials or access tokens.
- Before adding an app feature that calls the backend, check
  `server/routes/v1/__tests__/agent-parity/map.ts`: agents need the same
  capability (v1 route → SDK method → operation → MCP and CLI) or a recorded
  reason, and `agent-parity.test.ts` fails until one exists.
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

## Proactive pop-ups

- Use `AnnouncementDialog`, `AnnouncementSpotlight`, or `AnnouncementToast`
  for unsolicited pop-ups. Custom surfaces such as guided tours use
  `useAnnouncementSlot`. The Inspector shell pauses the shared queue during
  onboarding. Don't persist "seen" until the popup gets its turn.
- Keep required prompts, user-triggered dialogs, and action feedback out of
  this queue. The client typecheck flags direct custom toasts, feature
  spotlights, and raw dialogs/popovers that use `defaultOpen`. For openings
  driven by state or effects, verify the trigger in review and test that new
  announcements wait behind an existing one.

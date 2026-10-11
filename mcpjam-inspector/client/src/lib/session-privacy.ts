/**
 * Session privacy levels: what session replay and product analytics may
 * record in this browser session.
 *
 *   - `off`    — no replay at all. npx/Docker installs, `electron-forge start`,
 *                and builds with `VITE_DISABLE_POSTHOG_LOCAL`.
 *   - `masked` — replay of layout and interaction only: every text node and
 *                input masked, media blocked, no console logs, no network
 *                headers or bodies, and name-like URL segments replaced.
 *                Autocapture masks element text and attributes.
 *   - `full`   — replay as it has always been: inputs and annotated secret
 *                surfaces masked, everything else visible.
 *
 * Who gets which level is `resolveSessionPrivacy`. The level is applied to
 * BOTH recorders — PostHog here (`syncSessionRecording`), Sentry Replay in
 * `sentry.ts` (`syncSentryReplay`) — from the same module state, so the two
 * cannot disagree. `docs/session-replay-masking.md` has the table.
 *
 * Fail closed. Nothing records until the level is known; an answer that does
 * not arrive becomes `masked` (`useSessionPrivacy`), never `full`.
 *
 * The code is in `session-privacy/`: the level (`level.ts`), name scrubbing
 * for URLs (`url-names.ts`), the PostHog profiles (`posthog-replay.ts`) and
 * the Sentry Replay helpers (`sentry-replay.ts`). Import from here.
 */
export {
  currentSessionPrivacy,
  isCredentialBearingPath,
  isErrorCaptureSurface,
  recordingSurface,
  resolveEnterprisePrivacyInView,
  resolveEnterprisePrivacyMember,
  resolveSessionPrivacy,
  setSessionPrivacy,
  shouldMaskAnalytics,
  type PrivacyLevel,
  type PrivacyOrganization,
  type RecordingSurface,
  type SessionPrivacy,
  type SessionPrivacyInputs,
} from "./session-privacy/level";
export { scrubNamesFromUrl } from "./session-privacy/url-names";
export {
  lastSyncedPostHogClient,
  MASKED_BLOCK_SELECTOR,
  MASKED_SESSION_RECORDING_OPTIONS,
  maskReplayAttribute,
  maskReplayAttributeFull,
  maskReplayRequest,
  maskReplayRequestFull,
  maskReplayTextFull,
  maskReplayTextMasked,
  posthogPrivacyConfig,
  REPLAY_PLACEHOLDER_HREF,
  SECRET_SURFACE_ATTRIBUTE,
  SESSION_RECORDING_OPTIONS,
  syncSessionRecording,
  type PostHogProfile,
  type PostHogRecorder,
} from "./session-privacy/posthog-replay";
export {
  filterSentryReplayFrame,
  SENTRY_REPLAY_OPTIONS,
  SENTRY_UNMASKABLE_URL_ELEMENTS,
} from "./session-privacy/sentry-replay";

/**
 * Session privacy levels: what session replay and product analytics may
 * record in this browser session.
 *
 *   - `off`    — no replay at all. npx/Docker installs, `electron-forge start`
 *                and builds with `VITE_DISABLE_POSTHOG_LOCAL` (an `off`
 *                SURFACE), and anyone the backend answers `off` for: an
 *                organization with session replay off is in view, or the
 *                person belongs to one. On a recording surface, `off`
 *                analytics are masked like `masked` ones.
 *   - `masked` — replay of layout and interaction only: every text node and
 *                input masked, media blocked, no console logs, no network
 *                headers or bodies, and name-like URL segments replaced.
 *                Autocapture masks element text and attributes.
 *   - `full`   — replay as it has always been: inputs and annotated secret
 *                surfaces masked, everything else visible.
 *
 * Who gets which level is `resolveSessionPrivacy`, from the backend's answer
 * for the contexts in view (`telemetryPrivacy:getContext`, read by
 * `useTelemetryPrivacyContext`). The level is applied to BOTH recorders —
 * PostHog here (`syncSessionRecording`), Sentry Replay in `sentry.ts`
 * (`syncSentryReplay`) — from the same module state, so the two cannot
 * disagree. `docs/session-replay-masking.md` has the table.
 *
 * Fail closed. Nothing records until the backend has answered: an answer that
 * fails or never arrives keeps both recorders stopped (`useSessionPrivacy`),
 * and a person this browser last saw answered `off` stays `off`
 * (`replayOffRemembered`). After an answer has let the session record, a
 * navigation whose answer is still on its way records `masked`. The PostHog relay
 * enforces the same policy again on the server: it drops replay the backend
 * says is `off`, and restricted replay the client did not declare masked.
 *
 * The code is in `session-privacy/`: the level (`level.ts`), the PostHog
 * profiles (`posthog-replay.ts`) and their network masker
 * (`replay-network.ts`), and the Sentry Replay helpers (`sentry-replay.ts`).
 * URL names and masked attributes are shared with the relay
 * (`shared/telemetry-privacy.ts`). Import from here.
 */
export {
  APP_ROUTE_WORDS,
  maskReplayAttribute,
  scrubNamesFromUrl,
} from "../../../shared/telemetry-privacy";
export {
  currentSessionPrivacy,
  isCredentialBearingPath,
  isErrorCaptureSurface,
  recordingSurface,
  rememberReplayOff,
  replayOffRemembered,
  resetRememberedReplayOffForTests,
  resolveSessionPrivacy,
  setSessionPrivacy,
  shouldMaskAnalytics,
  type PrivacyLevel,
  type RecordingSurface,
  type SessionPrivacy,
  type SessionPrivacyInputs,
} from "./session-privacy/level";
export {
  maskReplayRequest,
  maskReplayRequestFull,
  REPLAY_PLACEHOLDER_HREF,
} from "./session-privacy/replay-network";
export {
  lastSyncedPostHogClient,
  MASKED_BLOCK_SELECTOR,
  MASKED_SESSION_RECORDING_OPTIONS,
  maskReplayAttributeFull,
  maskReplayTextFull,
  maskReplayTextMasked,
  posthogPrivacyConfig,
  replayFramesToSend,
  SECRET_SURFACE_ATTRIBUTE,
  SESSION_RECORDING_OPTIONS,
  syncSessionRecording,
  type PostHogProfile,
  type PostHogRecorder,
} from "./session-privacy/posthog-replay";
export {
  filterSentryBreadcrumb,
  filterSentryReplayFrame,
  SENTRY_REPLAY_OPTIONS,
  SENTRY_UNMASKABLE_URL_ELEMENTS,
  stripSelectorAttributes,
} from "./session-privacy/sentry-replay";

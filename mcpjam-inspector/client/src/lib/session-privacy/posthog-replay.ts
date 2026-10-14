/**
 * PostHog: the replay profile for each level (maskers and recording
 * options), its `set_config` argument, and `syncSessionRecording`, which
 * starts and stops the recorder.
 */
import {
  scrubCredentialsInText,
  type LocationLike,
} from "../../../../shared/credential-urls";
import {
  MASKED_REPLAY_BLOCKED_TAGS,
  maskReplayAttribute,
  maskReplayText,
} from "../../../../shared/telemetry-privacy";
import {
  currentSessionPrivacy,
  isCredentialBearingPath,
  isErrorCaptureSurface,
  recordingSurface,
  shouldMaskAnalytics,
} from "./level";
import { maskReplayRequest, maskReplayRequestFull } from "./replay-network";

export type PostHogProfile = "full" | "masked";

/**
 * Replay masking at `full`.
 *
 * `maskAllInputs` covers every `<input>`. The inspector also renders secrets
 * as TEXT — OAuth access/refresh tokens in the flow logger, the one-time API
 * key reveal, the SDK quickstart snippet — which no input-level masking can
 * reach. Those already carry this repo's `ph-no-capture rr-block` +
 * `data-ph-no-capture` convention for autocapture, so text under the SAME
 * attribute is masked in replay too: annotate a credential surface once and
 * it is opted out of autocapture AND masked in replay.
 */
export const SECRET_SURFACE_ATTRIBUTE = "data-ph-no-capture";

function isUnderSecretSurface(element: Element | null | undefined): boolean {
  try {
    return !!element?.closest?.(`[${SECRET_SURFACE_ATTRIBUTE}]`);
  } catch {
    return true;
  }
}

/**
 * `maskTextFn` at `full`. rrweb calls it only for text its `maskTextSelector`
 * matches, so the full profile matches every node (`*`) and decides here:
 * text under a secret surface is masked as before, and every other text node
 * keeps its words but loses any credential URL in it — a share link shown on
 * the page is a credential whatever the level.
 */
export function maskReplayTextFull(text: string, element?: Element): string {
  if (isUnderSecretSurface(element)) return maskReplayText(text);
  // No pre-check here: the registry runs its own (`/`, `=`, `%` or `:`), and
  // a narrower copy let `encodeURIComponent("/results/<token>")` through.
  return scrubCredentialsInText(text);
}

/** `maskTextFn` at `masked`: every text node, as `maskTextSelector: "*"` did. */
export function maskReplayTextMasked(text: string): string {
  return maskReplayText(text);
}

/**
 * `maskAttributeFn` at `full`: attribute values keep their content, minus any
 * credential URL — the Preview iframe's `src`, a share button's `href` or
 * `title`.
 */
export function maskReplayAttributeFull(_name: string, value: string): string {
  return scrubCredentialsInText(value);
}

export const SESSION_RECORDING_OPTIONS = {
  maskAllInputs: true,
  maskInputOptions: { password: true },
  // Every text node goes through `maskTextFn`; see `maskReplayTextFull`.
  maskTextSelector: "*",
  maskTextFn: maskReplayTextFull,
  maskAttributeFn: maskReplayAttributeFull,
  // Explicit at every level: `false` wins over the project's remote network
  // settings, so a dashboard toggle can never widen what is captured.
  recordHeaders: false,
  recordBody: false,
  maskCapturedNetworkRequestFn: maskReplayRequestFull,
  // Keep DOM events as plain JSON so the final relay serializer can inspect
  // stylesheet text that rrweb does not mask. posthog-js still gzips the
  // request body by default.
  compress_events: false,
} as const;

/** Media rrweb would otherwise copy into the replay. Blocked at `masked`. */
export const MASKED_BLOCK_SELECTOR = [...MASKED_REPLAY_BLOCKED_TAGS]
  .map((tag) => (tag === "image" ? "svg image" : tag))
  .join(", ");

export const MASKED_SESSION_RECORDING_OPTIONS = {
  maskAllInputs: true,
  maskInputOptions: { password: true },
  // `*` masks every text node; rrweb leaves `<style>` text alone.
  maskTextSelector: "*",
  maskTextFn: maskReplayTextMasked,
  blockSelector: MASKED_BLOCK_SELECTOR,
  maskAttributeFn: maskReplayAttribute,
  // `false` wins over the project's remote network settings.
  recordHeaders: false,
  recordBody: false,
  captureCanvas: { recordCanvas: false },
  captureJsonLd: false,
  recordCrossOriginIframes: false,
  maskCapturedNetworkRequestFn: maskReplayRequest,
  // See SESSION_RECORDING_OPTIONS.
  compress_events: false,
} as const;

/**
 * Everything posthog-js reads for one profile, as a `set_config` argument.
 * Replay options are read when the recorder starts, so changing profile
 * means stop, `set_config`, start. Autocapture reads its two flags per event.
 */
export function posthogPrivacyConfig(
  profile: PostHogProfile,
): Record<string, unknown> {
  return profile === "masked"
    ? {
        session_recording: MASKED_SESSION_RECORDING_OPTIONS,
        disable_session_recording: true,
        autocapture: false,
        capture_dead_clicks: false,
        rageclick: false,
        capture_exceptions: false,
        disable_surveys: true,
        enable_heatmaps: false,
        capture_performance: false,
        enable_recording_console_log: false,
        mask_all_text: true,
        mask_all_element_attributes: true,
      }
    : {
        session_recording: SESSION_RECORDING_OPTIONS,
        disable_session_recording: true,
        autocapture: true,
        capture_dead_clicks: true,
        rageclick: true,
        capture_exceptions: isErrorCaptureSurface(),
        disable_surveys: false,
        enable_heatmaps: true,
        // `null`, not `undefined` (posthog-js skips undefined in set_config):
        // console capture follows the project setting, as it always has.
        enable_recording_console_log: null,
        mask_all_text: false,
        mask_all_element_attributes: false,
      };
}

/** The posthog-js surface this module drives. Every method may be missing. */
export interface PostHogRecorder {
  startSessionRecording?: () => void;
  stopSessionRecording?: () => void;
  set_config?(config: Record<string, unknown>): void;
}

let posthogProfile: PostHogProfile | null = null;
let posthogRecording = false;
/** The client `syncSessionRecording` last drove, for the navigation guard. */
let lastPostHogClient: PostHogRecorder | null = null;

/** The PostHog client the recorders were last synced with, if any. */
export function lastSyncedPostHogClient(): PostHogRecorder | null {
  return lastPostHogClient;
}

// Stopping the recorder flushes its buffer through `before_send` — after the
// level has already tightened, so those frames would be stamped with the new,
// stricter label. Set only while a tightening stop runs.
let discardingReplayBuffer = false;
// Fresh recording boundary: reject delayed frames from an earlier privacy epoch.
let replayStartedAt: number | null = null;

interface ReplayFrameLike {
  timestamp?: unknown;
}

/** Reject strict captures and delayed frames recorded before the latest restart. */
export function replayFramesToSend(frames: unknown): unknown[] | null {
  if (discardingReplayBuffer || currentSessionPrivacy() !== "full") return null;
  if (!Array.isArray(frames)) return null;
  if (replayStartedAt === null) {
    return frames;
  }
  const startedAt = replayStartedAt;
  const kept = frames.filter((frame: ReplayFrameLike) => {
    const timestamp = frame?.timestamp;
    return typeof timestamp === "number" && timestamp >= startedAt;
  });
  return kept.length > 0 ? kept : null;
}

/**
 * Bring PostHog in line with the level in effect and the current path.
 *
 * Recording is OFF at init on every surface (`options.disable_session_recording`)
 * and only this function starts it, so there is one way in. A profile change
 * stops the recorder FIRST, then reconfigures, then starts again: nothing
 * past the stop records under the old profile, and the restart takes a fresh,
 * fresh snapshot. The caller (`useSessionPrivacy`) runs this in a
 * layout effect, before rrweb sees the DOM the new level is for.
 *
 * `startSessionRecording()` without an override still honours the project's
 * sampling, so starting again after a stop never records a session sampling
 * declined. `pending`, `off` and credential locations
 * (`isCredentialBearingPath`: path, query and fragment) hold the recorder
 * stopped; every surface starts with recording disabled.
 *
 * Never throws — this is a privacy guard on a render path, and posthog-js may
 * be ad-blocked or uninitialized.
 */
export function syncSessionRecording(
  client: PostHogRecorder,
  location: string | LocationLike,
): void {
  if (lastPostHogClient !== client) {
    discardingReplayBuffer = true;
    try {
      lastPostHogClient?.stopSessionRecording?.();
    } finally {
      discardingReplayBuffer = false;
    }
    posthogProfile = null;
    posthogRecording = false;
  }
  lastPostHogClient = client;
  try {
    const privacy = currentSessionPrivacy();
    // Full product capture need not wait for replay or run a recorder.
    const profile: PostHogProfile =
      shouldMaskAnalytics() || privacy === "masked" ? "masked" : "full";
    if (profile !== posthogProfile) {
      if (posthogRecording) {
        discardingReplayBuffer = profile === "masked";
        try {
          client.stopSessionRecording?.();
        } finally {
          discardingReplayBuffer = false;
        }
        posthogRecording = false;
      }
      client.set_config?.(posthogPrivacyConfig(profile));
      posthogProfile = profile;
    }
    const shouldRecord =
      recordingSurface() === "hosted" &&
      privacy === "full" &&
      !shouldMaskAnalytics() &&
      !isCredentialBearingPath(location);
    if (shouldRecord && !posthogRecording) {
      replayStartedAt = Date.now();
      client.startSessionRecording?.();
      posthogRecording = true;
    } else if (!shouldRecord && posthogRecording) {
      client.stopSessionRecording?.();
      posthogRecording = false;
    }
  } catch {
    // A failed guard must not break the render. Recording stays as-is.
  }
}

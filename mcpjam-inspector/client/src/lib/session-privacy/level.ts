/**
 * The level: which one this session gets (`resolveSessionPrivacy`), where
 * it records at all, the person a remembered `off` belongs to, and the level
 * in effect that both recorders read.
 */
import {
  isReplayBlockedLocation,
  type LocationLike,
} from "../../../../shared/credential-urls";
import type { TelemetryRecording } from "../../../../shared/telemetry-privacy";
import { HOSTED_MODE } from "../config";

export type PrivacyLevel = "off" | "masked" | "full";

/** A level, or `pending`: not known yet, and nothing records meanwhile. */
export type SessionPrivacy = PrivacyLevel | "pending";

/**
 * Whether this surface records session replays and captures exceptions.
 *
 * Hosted (app.mcpjam.com) and the packaged desktop app only. npx/Docker
 * installs run on someone else's machine against their own MCP servers —
 * recording those sessions is not ours to do, and the volume from every OSS
 * install would swamp the quota that makes hosted replay useful.
 */
export function isErrorCaptureSurface(): boolean {
  return HOSTED_MODE || isPackagedDesktop();
}

/**
 * A *shipped* desktop build, as opposed to `electron-forge start`.
 *
 * `src/preload.ts` exposes `isElectron: true` unconditionally, so it cannot
 * tell a packaged app from a developer's local run. `import.meta.env.PROD`
 * can: the dev renderer is served by the vite dev server, the packaged one is
 * a `vite build` output. Without this check every `electron-forge start`
 * session would stream renderer DOM and text into the production Sentry and
 * PostHog projects — and the boundary this file documents is *packaged*
 * desktop, not "anything with a preload attached".
 *
 * `HOSTED_MODE` needs no equivalent: it comes from `VITE_MCPJAM_HOSTED_MODE`,
 * which only the deployed bundle's config sets.
 */
function isPackagedDesktop(): boolean {
  return (
    import.meta.env.PROD &&
    typeof window !== "undefined" &&
    (window as unknown as { isElectron?: boolean }).isElectron === true
  );
}

/**
 * Whether neither recorder may run on this location, at any level: a
 * credential URL (`/results/<token>`, a tester link, an OAuth callback, any
 * secret query or fragment key — the registry in `shared/credential-urls.ts`
 * decides). A replay of such a page would capture the address bar, the DOM
 * that renders the secret and the requests that send it. Scrubbing those
 * afterwards is not a guarantee; not recording is.
 *
 * Takes a pathname (the old signature) or a whole location. With no argument
 * it reads the window's current location, search and fragment included.
 */
export function isCredentialBearingPath(
  location: string | LocationLike | undefined = currentLocation(),
): boolean {
  if (!location) return false;
  return isReplayBlockedLocation(
    typeof location === "string" ? { pathname: location } : location,
  );
}

function currentLocation(): LocationLike | undefined {
  if (typeof window === "undefined" || !window.location) return undefined;
  const { pathname, search, hash } = window.location;
  return { pathname, search, hash };
}

export type RecordingSurface = "off" | "desktop" | "hosted";

/** Where this session runs, as far as recording is concerned. */
export function recordingSurface(): RecordingSurface {
  if (
    !isErrorCaptureSurface() ||
    import.meta.env.VITE_DISABLE_POSTHOG_LOCAL === "true"
  ) {
    return "off";
  }
  return HOSTED_MODE ? "hosted" : "desktop";
}

export interface SessionPrivacyInputs {
  surface: RecordingSurface;
  /**
   * A share-link page (a published study's tester chat) that shows a project
   * the viewer may not belong to, so its organization's posture is unknown.
   */
  sharedLink: boolean;
  /**
   * The backend's recording level for the contexts in view, for the current
   * actor (`useTelemetryPrivacyContext`). `undefined` = not answered yet.
   * Anything the backend could not verify — no context in view, no access,
   * no authentication — already arrives as `masked`.
   */
  recording: TelemetryRecording | undefined;
}

/**
 * The level for this session. Pure: the caller supplies the facts.
 *
 * - npx/Docker and dev builds: `off`.
 * - Share links: `off`. The page shows an organization the viewer may not
 *   belong to; the backend answers for the viewer, not the page's owner,
 *   whose replay might be off.
 * - Everywhere else, `pending` until the backend answers, and `off` when it
 *   answers `off`: no replay for an organization with session replay off, on
 *   any surface.
 * - Packaged desktop: otherwise `masked` for everyone. It records people
 *   debugging their own MCP servers on their own machines, which is the npx
 *   reasoning with replay kept for crash debugging.
 * - Hosted otherwise: the backend's answer. Only a verified non-private
 *   context gets `full`; visitors with no session, and pages with nothing in
 *   view, are `masked`.
 */
export function resolveSessionPrivacy(
  inputs: SessionPrivacyInputs,
): SessionPrivacy {
  // A share-link page shows an organization's content to a viewer who may
  // not belong to it. The backend answers for the viewer, not the page's
  // owner, whose replay might be off, so nothing records there at all.
  if (inputs.surface === "off" || inputs.sharedLink) return "off";
  if (inputs.recording === undefined) return "pending";
  if (inputs.recording === "off") return "off";
  if (inputs.surface === "desktop") return "masked";
  return inputs.recording === "full" ? "full" : "masked";
}

// ── Remembered `off` ───────────────────────────────────────────────────

const REPLAY_OFF_STORAGE_KEY = "mcpjam.telemetry.replayOffActor";
let replayOffActor: string | null | undefined;

function readReplayOffActor(): string | null {
  if (replayOffActor !== undefined) return replayOffActor;
  try {
    replayOffActor = window.localStorage.getItem(REPLAY_OFF_STORAGE_KEY);
  } catch {
    replayOffActor = null;
  }
  return replayOffActor;
}

/**
 * Record the backend's answer for `actorId`: whether replay is `off` for
 * them. Kept in memory and, where storage works, across reloads, so a person
 * whose organization has replay off is never recorded while the answer is
 * slow, failing or not asked yet. Only real answers belong here.
 */
export function rememberReplayOff(actorId: string | null, off: boolean): void {
  if (actorId === null) return;
  const current = readReplayOffActor();
  const next = off ? actorId : current === actorId ? null : current;
  if (next === current) return;
  replayOffActor = next;
  try {
    if (next === null) window.localStorage.removeItem(REPLAY_OFF_STORAGE_KEY);
    else window.localStorage.setItem(REPLAY_OFF_STORAGE_KEY, next);
  } catch {
    // Memory still holds it for this page.
  }
}

/**
 * Whether `actorId` was last answered `off` in this browser. `undefined` is
 * an actor not known yet (sign-in still loading): it counts when anyone was,
 * because it is most likely the same person.
 */
export function replayOffRemembered(
  actorId: string | null | undefined,
): boolean {
  const remembered = readReplayOffActor();
  if (remembered === null) return false;
  return actorId === undefined || actorId === remembered;
}

/** Tests only. */
export function resetRememberedReplayOffForTests(): void {
  replayOffActor = undefined;
}

// ── The level in effect ────────────────────────────────────────────────

let sessionPrivacy: SessionPrivacy | undefined;

/** The level in effect. Before anything is resolved: `pending`, or `off`. */
export function currentSessionPrivacy(): SessionPrivacy {
  return sessionPrivacy ?? (recordingSurface() === "off" ? "off" : "pending");
}

/** Set by `useSessionPrivacy` only. The recorders read it when synced. */
export function setSessionPrivacy(level: SessionPrivacy): void {
  sessionPrivacy = level;
}

/**
 * Whether analytics must keep names out right now: on a recording surface,
 * anything short of a resolved `full` — replay `off` included. `off`
 * surfaces keep today's analytics.
 */
export function shouldMaskAnalytics(): boolean {
  const privacy = currentSessionPrivacy();
  if (privacy === "full") return false;
  return privacy !== "off" || recordingSurface() !== "off";
}

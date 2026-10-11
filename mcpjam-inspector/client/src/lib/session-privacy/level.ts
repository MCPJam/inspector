/**
 * The level: which one this session gets (`resolveSessionPrivacy`), where
 * it records at all, and the level in effect that both recorders read.
 */
import {
  isReplayBlockedLocation,
  type LocationLike,
} from "../../../../shared/credential-urls";
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
   * The WorkOS session. A guest has none: `signed_out` covers both visitors
   * and guests, whose data is their own and who belong to no organization
   * that could ask for privacy.
   */
  account: "loading" | "signed_out" | "signed_in";
  /**
   * A share-link page (a published study's tester chat) that shows a project
   * the viewer may not belong to, so its organization's posture is unknown.
   */
  sharedLink: boolean;
  /** `resolveEnterprisePrivacyInView`; `undefined` = not known yet. */
  enterprisePrivacyInView: boolean | undefined;
}

/**
 * The level for this session. Pure: the caller supplies the facts.
 *
 * - npx/Docker and dev builds: `off`.
 * - Packaged desktop: `masked` for everyone. It records people debugging their
 *   own MCP servers on their own machines, which is the npx reasoning with
 *   replay kept for crash debugging.
 * - Hosted share links: `masked` — whose data it is cannot be known here.
 * - Hosted, signed out (visitors, guests): `full`. Landing pages and a
 *   guest's own sandbox carry no organization's data.
 * - Hosted, signed in: `masked` when any organization in view has enterprise
 *   privacy, `full` when none does, `pending` until that is known.
 */
export function resolveSessionPrivacy(
  inputs: SessionPrivacyInputs,
): SessionPrivacy {
  if (inputs.surface === "off") return "off";
  if (inputs.surface === "desktop") return "masked";
  if (inputs.sharedLink) return "masked";
  if (inputs.account === "loading") return "pending";
  if (inputs.account === "signed_out") return "full";
  if (inputs.enterprisePrivacyInView === undefined) return "pending";
  return inputs.enterprisePrivacyInView ? "masked" : "full";
}

/**
 * The organization fields this module reads. `enterprisePrivacy` is on the
 * organization row `organizations:getMyOrganizations` returns; it switches on
 * when an organization moves to Enterprise and can be set explicitly.
 */
export interface PrivacyOrganization {
  _id: string;
  enterprisePrivacy?: boolean;
}

/**
 * Whether an organization in view (the route's, the active one, the active
 * project's) has enterprise privacy: any one is enough. `undefined` while
 * the list has not loaded or nothing is in view — never a guess.
 */
export function resolveEnterprisePrivacyInView(
  organizations: readonly PrivacyOrganization[] | undefined,
  organizationIdsInView: ReadonlyArray<string | null | undefined>,
): boolean | undefined {
  if (!organizations) return undefined;
  const inView = organizationIdsInView.filter((id): id is string => !!id);
  if (inView.length === 0) return undefined;
  return organizations.some(
    (org) => org.enterprisePrivacy === true && inView.includes(org._id),
  );
}

/**
 * Whether the signed-in person belongs to ANY organization with enterprise
 * privacy. Identity follows membership, not the organization in view,
 * because person properties outlive the page. `undefined` until the list
 * has loaded; `usePostHogIdentify` sends the id alone until this is `false`.
 */
export function resolveEnterprisePrivacyMember(
  organizations: readonly PrivacyOrganization[] | undefined,
): boolean | undefined {
  if (!organizations) return undefined;
  return organizations.some((org) => org.enterprisePrivacy === true);
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
 * anything short of a resolved `full`. `off` surfaces keep today's analytics.
 */
export function shouldMaskAnalytics(): boolean {
  const privacy = currentSessionPrivacy();
  return privacy === "masked" || privacy === "pending";
}

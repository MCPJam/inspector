/**
 * Inspector → backend client for the Slack surfaces (`/slack/*`).
 *
 * Used by two callers with the same trust level: the `slk_` auth branch in
 * `bearer-auth.ts` (which needs the acting user's account link) and the
 * account-link bridge in `routes/slack-link` (which drives the link session
 * state machine). Both authenticate with `INSPECTOR_SERVICE_TOKEN`.
 *
 * FAILURE SEMANTICS ARE THE POINT. Every function here throws
 * `SlackBackendUnavailable` when the backend could not answer, and returns a
 * value only when it did. Collapsing those two into "no link" would tell a
 * linked user to connect their account because of a network blip — and would
 * do it on the auth path, where the user has no way to tell the difference.
 */
import { getInternalBackendConfig } from "./internal-backend.js";

const REQUEST_TIMEOUT_MS = 10_000;

/** The backend could not answer. Distinct from "answered: no". */
export class SlackBackendUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackBackendUnavailable";
  }
}

async function post<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  let config: { convexUrl: string; serviceToken: string };
  try {
    config = getInternalBackendConfig();
  } catch (error) {
    throw new SlackBackendUnavailable(
      `Slack backend is not configured: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const controller = new AbortController();
  // The timeout must cover the WHOLE exchange, body included. Clearing it once
  // headers arrive would let a response that never finishes its body hang this
  // request forever — and this runs on the auth path, so the hang would be a
  // request that never answers rather than one that fails.
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${config.convexUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-inspector-service-token": config.serviceToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new SlackBackendUnavailable(
        `Slack backend request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!response.ok) {
      // Including 4xx: a malformed request from US is still a state in which
      // we do not know the answer, and guessing on the auth path is worse
      // than a retryable error.
      throw new SlackBackendUnavailable(
        `Slack backend returned ${response.status} for ${path}`
      );
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new SlackBackendUnavailable(
        `Slack backend returned an unreadable body for ${path}: ${error}`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

export interface SlackAccountLink {
  userId: string;
  workosUserId: string;
  organizationId: string;
  defaultProjectId: string | null;
}

/**
 * Which MCPJam identity a Slack user currently acts as.
 * `null` means NOT LINKED — an answer. Unreachable backend throws.
 */
export async function resolveSlackActingUser(
  teamId: string,
  slackUserId: string
): Promise<SlackAccountLink | null> {
  const body = await post<{ ok?: boolean; link?: SlackAccountLink | null }>(
    "/slack/service-auth/resolve",
    { teamId, slackUserId }
  );
  return body.link ?? null;
}

// ── Link-session state machine ─────────────────────────────────────────

export interface SlackLinkSession {
  linkSessionId: string;
  teamId: string;
  slackUserId: string;
  oidcNonce: string;
  slackStateHash: string;
  workosStateHash: string;
  status:
    | "pending_slack"
    | "slack_verified"
    | "workos_verified"
    | "consumed"
    | "failed"
    | "expired";
  expiresAt: number;
  expired: boolean;
}

export async function createSlackLinkSession(args: {
  linkSessionId: string;
  teamId: string;
  slackUserId: string;
  oidcNonce: string;
  slackStateHash: string;
  workosStateHash: string;
}): Promise<{ ok: boolean }> {
  return post("/slack/link-sessions/create", args);
}

export async function getSlackLinkSession(
  linkSessionId: string
): Promise<SlackLinkSession | null> {
  const body = await post<{ session?: SlackLinkSession | null }>(
    "/slack/link-sessions/get",
    { linkSessionId }
  );
  return body.session ?? null;
}

export async function markSlackLegVerified(args: {
  linkSessionId: string;
  verifiedTeamId: string;
  verifiedSlackUserId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return post("/slack/link-sessions/slack-verified", args);
}

export async function markWorkosLegVerified(
  linkSessionId: string
): Promise<{ ok: boolean; reason?: string }> {
  return post("/slack/link-sessions/workos-verified", { linkSessionId });
}

export async function failSlackLinkSession(
  linkSessionId: string,
  reason: string
): Promise<void> {
  await post("/slack/link-sessions/fail", { linkSessionId, reason });
}

export async function consumeSlackLinkSession(args: {
  linkSessionId: string;
  userId: string;
  workosUserId: string;
  organizationId: string;
}): Promise<{ ok: boolean; reason?: string; teamId?: string; slackUserId?: string; relinked?: boolean }> {
  return post("/slack/link-sessions/consume", args);
}

export async function resolveOrganizationByWorkosId(
  workosOrganizationId: string
): Promise<{ organizationId: string; name: string } | null> {
  const body = await post<{
    organization?: { organizationId: string; name: string } | null;
  }>("/slack/organizations/by-workos-id", { workosOrganizationId });
  return body.organization ?? null;
}

export async function setSlackDefaultProject(args: {
  teamId: string;
  slackUserId: string;
  projectId?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return post("/slack/links/set-default-project", args);
}

// ── Proposed actions ───────────────────────────────────────────────────
//
// SURFACE-NEUTRAL WIRE, SLACK-NAMED PATH. The bodies below speak the generic
// surface quad; the paths still say `/slack/…` because the backend serves both
// spellings on the same handlers and switching the path is a separate, riskier
// change than switching the payload. The `/agent/…` aliases exist and are what
// a second wrapper will use once there is one to test the switch with.
//
// BOTH SPELLINGS GO ON THE WIRE for a Slack proposal. The new backend prefers
// the generic quad and ignores the aliases; a backend that PREDATES the generic
// columns requires them and would 400 without them. Sending both costs a few
// bytes and buys the property that matters more: this build works against
// either backend version, so a slipped deploy order or a backend rollback
// cannot strand approvals. Only a non-Slack surface omits them — see the
// backend's `legacySlackOf` for why it must not borrow that id space.

export async function createProposedAction(args: {
  actionId: string;
  /** Which chat product ("slack", …). */
  surface: string;
  /** Workspace / guild id inside that product. */
  surfaceTenantId: string;
  /** The proposing human's id inside that product. */
  surfaceActorId: string;
  /** Where the approval control will be rendered. */
  surfaceConversationId: string;
  operation: string;
  input: unknown;
  organizationId: string;
  projectId: string;
}): Promise<{ created: boolean }> {
  return post("/slack/proposed-actions/create", {
    ...args,
    ...(args.surface === "slack"
      ? {
          teamId: args.surfaceTenantId,
          channelId: args.surfaceConversationId,
          proposedBySlackUserId: args.surfaceActorId,
        }
      : {}),
  });
}

export interface ProposedActionRecord {
  actionId: string;
  /**
   * Absent on a row written before the surface columns existed — same reason
   * as the identity fields below. The route's `record.surface ?? "slack"` is
   * the deliberate legacy fallback, not unreachable defence.
   */
  surface: string | null;
  surfaceTenantId: string | null;
  surfaceActorId: string | null;
  surfaceConversationId: string | null;
  surfaceExecutorId: string | null;
  /**
   * Slack spelling of the tenant, when the row has one.
   *
   * Kept as a FALLBACK only: a row written before the generic columns existed
   * carries the tenant here and nowhere else, and the backend mirrors it
   * forward on read. Reading `surfaceTenantId` first is what makes a non-Slack
   * row work; reading this at all is what makes a mid-deploy Slack row work.
   */
  teamId: string | null;
  channelId: string | null;
  operation: string;
  input: Record<string, unknown>;
  organizationId: string;
  projectId: string;
  status: "proposed" | "executing" | "succeeded" | "failed" | "expired";
  expired: boolean;
}

export async function getProposedAction(
  actionId: string
): Promise<ProposedActionRecord | null> {
  const body = await post<{ action?: ProposedActionRecord | null }>(
    "/slack/proposed-actions/get",
    { actionId }
  );
  return body.action ?? null;
}

/**
 * `proposed → executing`, returning WHAT TO RUN.
 *
 * The returned `operation` and `input` are the persisted ones. The executor
 * must use exactly these and nothing from the click payload: a Block Kit
 * button's `value` can be minted by anyone able to post in the workspace, so a
 * click may only say WHICH proposal to run, never what it does.
 */
export type BeginProposedActionResult =
  | {
      ok: true;
      operation: string;
      input: Record<string, unknown>;
      organizationId: string;
      projectId: string;
      surface: string;
      surfaceTenantId: string | null;
      surfaceConversationId: string | null;
      /** Slack spelling of the tenant; fallback for a pre-abstraction row. */
      teamId: string | null;
    }
  | {
      ok: false;
      reason: "not_found" | "expired" | "already_claimed";
      status?: string;
    };

export async function beginProposedAction(args: {
  actionId: string;
  /** The CLICKER, in the surface's own id space — never the proposer. */
  executorId: string;
}): Promise<BeginProposedActionResult> {
  // Both spellings, for the same reason as `createProposedAction`: a backend
  // that predates `executorId` requires `executedBySlackUserId`, and a claim
  // that 400s is an approval the user watched fail.
  return post("/slack/proposed-actions/begin", {
    ...args,
    executedBySlackUserId: args.executorId,
  });
}

export async function completeProposedAction(args: {
  actionId: string;
  status: "succeeded" | "failed";
  failureReason?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return post("/slack/proposed-actions/complete", args);
}

/** Only for work that provably did NOT start. See `releaseExecution`. */
export async function releaseProposedAction(
  actionId: string
): Promise<{ released: boolean }> {
  return post("/slack/proposed-actions/release", { actionId });
}

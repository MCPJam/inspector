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
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Including 4xx: a malformed request from US is still a state in which we
    // do not know the answer, and guessing on the auth path is worse than a
    // retryable error.
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

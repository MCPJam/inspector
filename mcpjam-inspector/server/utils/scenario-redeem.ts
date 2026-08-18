/**
 * Scenario token redemption.
 *
 * Calls `/web/scenario/redeem` on the Convex HTTP layer to exchange a
 * scenario link token for a `scenarioId` + `scenarioAccess` grant. Once
 * redeemed, the inspector forwards the `scenarioId` (NOT the token) on
 * every subsequent hot-path request.
 *
 * The bearer is required: WorkOS bearer for signed-in viewers, or a
 * guest JWT obtained via `/guest/session` for anonymous viewers in
 * `anyone_with_link` mode. Anonymous redemption is rejected by the
 * backend with 401.
 */

import { logger } from "./logger.js";
import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config/internal";

export type ScenarioRedeemBootstrapServer = {
  serverId: string;
  serverName: string;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
  oauthScopes: string[] | null;
  optional: boolean;
};

/**
 * Full bootstrap payload returned by `/web/scenario/redeem`. Mirrors the
 * shape inspector clients previously fetched from `/scenario/bootstrap`,
 * so the landing page can validate this directly against
 * `ScenarioBootstrapPayload` before persisting the session.
 */
export type ScenarioRedeemBootstrap = {
  projectId: string | null;
  scenarioId: string;
  name: string;
  description: string | null;
  hostStyle: "claude" | "chatgpt" | string;
  mode: "project_members" | "invited_only" | "anyone_with_link";
  allowGuestAccess: boolean;
  viewerIsProjectMember: boolean;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  welcomeDialog: unknown | null;
  feedbackDialog: unknown | null;
  servers: ScenarioRedeemBootstrapServer[];
};

export type ScenarioRedeemSuccess = {
  ok: true;
  scenarioId: string;
  role: "chat" | "admin";
  mode: "project_members" | "invited_only" | "anyone_with_link";
  projectId: string | null;
  accessVersion: number;
  bootstrap: ScenarioRedeemBootstrap;
};

export type ScenarioRedeemFailure = {
  ok: false;
  status: number;
  error: string;
  /**
   * The backend's DOMAIN code, when it sent one — today that means an `ENV_*`
   * environment-resolution failure (mcpjam-backend #890): the link and the
   * access check both passed, and only the environment behind the scenario is
   * unavailable. Carried separately from the HTTP status because "archived on
   * purpose" and "temporarily unresolvable" share a 4xx but read very
   * differently to the visitor.
   */
  code?: string;
};

export type ScenarioRedeemResult = ScenarioRedeemSuccess | ScenarioRedeemFailure;

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for scenario redeem");
  }
  return convexHttpUrl;
}

function buildRedeemUrl(): string {
  return (
    process.env.MCPJAM_SCENARIO_REDEEM_URL ||
    new URL("/web/scenario/redeem", getConvexHttpUrl()).toString()
  );
}

export async function redeemScenarioToken(args: {
  scenarioToken: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<ScenarioRedeemResult> {
  const url = buildRedeemUrl();
  const authorization = args.bearer.startsWith("Bearer ")
    ? args.bearer
    : `Bearer ${args.bearer}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify({ scenarioToken: args.scenarioToken }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[scenario-redeem] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach scenario redeem endpoint",
    };
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      // If the upstream returned 2xx but no parseable JSON, that's an
      // upstream contract violation — surface it as 502 so callers don't
      // treat the missing body as success.
      status: response.ok ? 502 : response.status,
      error: `Scenario redeem returned ${response.status} with non-JSON body`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Scenario redeem failed (${response.status})`,
      ...(typeof payload?.code === "string" ? { code: payload.code } : {}),
    };
  }

  if (payload?.ok !== true) {
    // 2xx with `ok: false` (or missing) is also an upstream contract
    // violation — coerce to 502 so callers don't bubble a misleading 200.
    return {
      ok: false,
      status: 502,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : "Scenario redeem response was missing ok=true",
    };
  }

  return {
    ok: true,
    scenarioId: payload.scenarioId,
    role: payload.role,
    mode: payload.mode,
    projectId: payload.projectId ?? null,
    accessVersion: payload.accessVersion,
    bootstrap: payload.bootstrap,
  };
}

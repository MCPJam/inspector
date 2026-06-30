/**
 * Header-broker start/revoke client (enterprise harness credential delivery).
 *
 * Unlike `harness-model-credential.ts` (which returns a real key to inject into
 * the sandbox env), the broker NEVER hands the inspector a lease. Convex mints
 * it, locks the sandbox's egress to the proxy host, and installs it into E2B's
 * egress header transform — so the lease is injected OUTSIDE the VM and the
 * inspector/sandbox never hold it. We get back only the proxy base URL + runId;
 * the harness CLIs run with DUMMY local creds pointed at that proxy.
 *
 * Backed by `convex/http.ts:/web/harness/model-broker/{start,revoke}`.
 */
import { logger } from "../logger.js";

export type HarnessBrokerStartResult =
  | {
      ok: true;
      runId: string;
      expiresAt: number;
      protocol: "anthropic" | "openai";
      proxyBaseUrl: string;
      delivery: "e2b-network-transform";
    }
  | { ok: false; status: number; error: string };

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for harness model broker");
  }
  return convexHttpUrl;
}

function bearerHeader(bearer: string): string {
  const trimmed = bearer.trim();
  return /^Bearer\s/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

export async function startHarnessModelBroker(args: {
  projectId: string;
  computerId: string;
  harnessId: "claude-code" | "codex";
  modelId: string;
  runId?: string;
  maxOutputTokens?: number;
  bearer: string;
  signal?: AbortSignal;
}): Promise<HarnessBrokerStartResult> {
  let url: string;
  try {
    url = new URL(
      "/web/harness/model-broker/start",
      getConvexHttpUrl()
    ).toString();
  } catch (err) {
    logger.error("[harness-model-broker] missing endpoint config", err);
    return {
      ok: false,
      status: 500,
      error: "Harness model-broker endpoint is not configured",
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: bearerHeader(args.bearer),
      },
      body: JSON.stringify({
        projectId: args.projectId,
        computerId: args.computerId,
        harnessId: args.harnessId,
        modelId: args.modelId,
        ...(args.runId ? { runId: args.runId } : {}),
        ...(args.maxOutputTokens !== undefined
          ? { maxOutputTokens: args.maxOutputTokens }
          : {}),
      }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[harness-model-broker] network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach harness model-broker endpoint",
    };
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: `Harness model-broker returned ${response.status} with non-JSON body`,
    };
  }

  if (
    !response.ok ||
    payload?.ok !== true ||
    typeof payload?.proxyBaseUrl !== "string" ||
    typeof payload?.runId !== "string"
  ) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Harness model-broker failed (${response.status})`,
    };
  }

  return {
    ok: true,
    runId: payload.runId,
    expiresAt: payload.expiresAt,
    protocol: payload.protocol,
    proxyBaseUrl: payload.proxyBaseUrl,
    delivery: "e2b-network-transform",
  };
}

/**
 * Best-effort revoke on harness teardown/abort. Revocation is the source of
 * truth server-side; a failure here is logged (not retried in the user flow) —
 * TTL + the backend cron backstop a missed revoke.
 */
export async function revokeHarnessModelBroker(args: {
  projectId?: string;
  computerId?: string;
  runId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; revoked?: number; networkCleared?: boolean }> {
  let url: string;
  try {
    url = new URL(
      "/web/harness/model-broker/revoke",
      getConvexHttpUrl()
    ).toString();
  } catch (err) {
    logger.error("[harness-model-broker] missing revoke endpoint config", err);
    return { ok: false };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: bearerHeader(args.bearer),
      },
      body: JSON.stringify({
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.computerId ? { computerId: args.computerId } : {}),
        runId: args.runId,
      }),
      signal: args.signal,
    });
    const payload: any = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      logger.warn(`[harness-model-broker] revoke returned ${response.status}`);
      return { ok: false };
    }
    return {
      ok: true,
      revoked: payload.revoked,
      networkCleared: payload.networkCleared,
    };
  } catch (err) {
    logger.warn("[harness-model-broker] revoke network error", err);
    return { ok: false };
  }
}

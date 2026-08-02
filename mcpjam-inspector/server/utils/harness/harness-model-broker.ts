/**
 * Header-broker start/revoke client — the ONLY harness credential delivery
 * path since COMP-23 (the raw-key `harness-model-credential.ts` client, which
 * returned a real unmetered key to inject into the sandbox env, was removed).
 *
 * The broker NEVER hands the inspector a lease. Convex mints it, locks the
 * sandbox's egress to the proxy host, and installs it into E2B's egress header
 * transform — so the lease is injected OUTSIDE the VM and the inspector/sandbox
 * never hold it. We get back only the proxy base URL + runId; the harness CLIs
 * run with DUMMY local creds pointed at that proxy.
 *
 * Backed by `convex/http.ts:/web/harness/model-broker/{start,revoke}`.
 */
import type { ExecutionScope } from "../execution-scope.js";
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

/**
 * Which box the lease binds to — the backend requires EXACTLY ONE, and rejects
 * a request that names both.
 *
 * `computer` is the acting member's persistent project computer (playground,
 * chat, evals). `sandbox` is a per-attempt disposable box a swarm session
 * already provisioned (B-isolation phase 6); the backend re-derives the run,
 * attempt, project and org from that row, so nothing else travels with it — in
 * particular the caller does NOT get to say which project to bill.
 */
export type HarnessBrokerBox =
  | {
      kind: "computer";
      computerId: string;
      /** The project to authorize + bill against. Required here, and ONLY here. */
      projectId: string;
      /** Phase 3 scope; when present the backend runs the host-funded guest path
       *  (re-resolve access, require harness capability, per-swarm daily cap).
       *  A personal-computer concept — the backend rejects it on the sandbox
       *  path, so it lives on this arm rather than beside it. */
      executionScope?: ExecutionScope;
    }
  | {
      kind: "sandbox";
      sandboxRowId: string;
      // NO projectId, and no executionScope, BY CONSTRUCTION. The backend
      // derives project + billing org from the sandbox row's run, so a
      // caller-selected project would be an input it must remember to ignore —
      // and "remember to ignore" is how a trusted field gets read one day.
      // Keeping the fields off this arm means there is nothing to serialize
      // and nothing to re-check: the request cannot carry them.
    };

export async function startHarnessModelBroker(args: {
  box: HarnessBrokerBox;
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
      // Serialized STRAIGHT off the discriminated box — the project and the
      // scope are fields of the `computer` arm, so the sandbox path has no
      // branch that could emit them and no way to regress into one.
      body: JSON.stringify({
        ...(args.box.kind === "computer"
          ? {
              projectId: args.box.projectId,
              computerId: args.box.computerId,
              ...(args.box.executionScope
                ? { executionScope: args.box.executionScope }
                : {}),
            }
          : { sandboxRowId: args.box.sandboxRowId }),
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

  const validShape =
    response.ok &&
    payload?.ok === true &&
    typeof payload?.runId === "string" &&
    payload.runId.length > 0 &&
    typeof payload?.proxyBaseUrl === "string" &&
    payload.proxyBaseUrl.length > 0 &&
    typeof payload?.expiresAt === "number" &&
    Number.isFinite(payload.expiresAt) &&
    (payload?.protocol === "anthropic" || payload?.protocol === "openai") &&
    payload?.delivery === "e2b-network-transform";
  if (!validShape) {
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

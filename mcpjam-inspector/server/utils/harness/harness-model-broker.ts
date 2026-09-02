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
import type { HarnessId } from "./registry.js";
/**
 * Every registered harness id — reserve/renew/release are taken by EVERY
 * harness, brokered or not: an external-account harness still runs its CLI in
 * the customer's box, so it claims that box for the span of a turn's
 * preparation exactly like a brokered one does.
 *
 * `startHarnessModelBroker` is typed the same but must never be REACHED for an
 * external-account harness. Three things stop it, and none of them is this
 * type: `runHarnessTurn` branches on the adapter's `modelAccess` and skips the
 * start entirely, `buildBrokerDummyAuth` throws if anything asks it for
 * credentials that do not exist, and the backend's `/model-broker/start`
 * refuses the request outright.
 */

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

/**
 * The box, as request fields. Serialized STRAIGHT off the discriminated union —
 * the project and the scope are fields of the `computer` arm, so the sandbox
 * path has no branch that could emit them and no way to regress into one.
 */
function boxRequestFields(box: HarnessBrokerBox): Record<string, unknown> {
  return box.kind === "computer"
    ? {
        projectId: box.projectId,
        computerId: box.computerId,
        ...(box.executionScope ? { executionScope: box.executionScope } : {}),
      }
    : { sandboxRowId: box.sandboxRowId };
}

export async function startHarnessModelBroker(args: {
  box: HarnessBrokerBox;
  harnessId: HarnessId;
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
        ...boxRequestFields(args.box),
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
    logger.warn("[harness-model-broker] revoke network error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

export type HarnessBoxReservationResult =
  | {
      ok: true;
      expiresAt?: number;
    }
  | { ok: false; status: number; error: string };

/**
 * Claim a box for the span of a turn's PREPARATION — waking it and installing
 * the harness runtime, all of which happens before the lease exists and
 * therefore outside the protection of the lease's own per-box fence. The lease
 * consumes this claim when it is minted (matched on `runId`).
 *
 * A missing endpoint is a hard failure. Continuing without a claim would
 * silently restore the preparation race this endpoint exists to close, so an
 * inspector must be rolled out only after the reservation-capable backend.
 */
export async function reserveHarnessBox(args: {
  box: HarnessBrokerBox;
  harnessId: HarnessId;
  modelId: string;
  runId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<HarnessBoxReservationResult> {
  let url: string;
  try {
    url = new URL(
      "/web/harness/model-broker/reserve",
      getConvexHttpUrl()
    ).toString();
  } catch (err) {
    logger.error("[harness-model-broker] missing reserve endpoint config", err);
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
        ...boxRequestFields(args.box),
        // The same harness + model the lease will name: the backend authorizes a
        // reservation exactly as it authorizes a lease, which for an ephemeral
        // box means checking both against what the run actually pinned.
        harnessId: args.harnessId,
        modelId: args.modelId,
        runId: args.runId,
      }),
      signal: args.signal,
    });
  } catch (err) {
    logger.error("[harness-model-broker] reserve network error", err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach harness model-broker endpoint",
    };
  }

  const payload: any = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    return {
      ok: false,
      status: response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `Couldn't reserve the computer (${response.status})`,
    };
  }
  return {
    ok: true,
    ...(typeof payload.expiresAt === "number"
      ? { expiresAt: payload.expiresAt }
      : {}),
  };
}

/** Renew the preparation claim before its crash-recovery TTL elapses. */
export async function renewHarnessBoxReservation(args: {
  box: HarnessBrokerBox;
  harnessId: HarnessId;
  modelId: string;
  runId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; expiresAt?: number }> {
  let url: string;
  try {
    url = new URL(
      "/web/harness/model-broker/reserve/renew",
      getConvexHttpUrl()
    ).toString();
  } catch {
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
        ...boxRequestFields(args.box),
        harnessId: args.harnessId,
        modelId: args.modelId,
        runId: args.runId,
      }),
      signal: args.signal,
    });
    const payload: any = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      logger.error(
        `[harness-model-broker] reservation renewal returned ${response.status}`
      );
      return { ok: false };
    }
    return {
      ok: true,
      ...(typeof payload.expiresAt === "number"
        ? { expiresAt: payload.expiresAt }
        : {}),
    };
  } catch (err) {
    logger.error(
      "[harness-model-broker] reservation renewal network error",
      err
    );
    return { ok: false };
  }
}

/**
 * Hand a claimed box back after a failed or aborted preparation. Best-effort:
 * the reservation's TTL is the real guarantee, and a turn that dies without
 * releasing must not wedge the box for longer than that.
 */
export async function releaseHarnessBoxReservation(args: {
  box: HarnessBrokerBox;
  harnessId: HarnessId;
  modelId: string;
  runId: string;
  bearer: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean }> {
  let url: string;
  try {
    url = new URL(
      "/web/harness/model-broker/reserve/release",
      getConvexHttpUrl()
    ).toString();
  } catch {
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
        ...boxRequestFields(args.box),
        harnessId: args.harnessId,
        modelId: args.modelId,
        runId: args.runId,
      }),
      signal: args.signal,
    });
    if (!response.ok) {
      logger.warn(
        `[harness-model-broker] reservation release returned ${response.status}`
      );
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    logger.error("[harness-model-broker] reservation release network error", err);
    return { ok: false };
  }
}

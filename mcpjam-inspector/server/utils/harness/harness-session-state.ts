/**
 * Inspector → Convex client for harness multi-turn continuity (the generic
 * `harnessSessions` lane). Mirrors `harness-model-credential.ts`.
 *
 * The lane is keyed server-side by (projectId, harnessId, ownerType, ownerKey);
 * the inspector supplies the owner-identifying fields and the signed-in userId
 * is injected server-side from the bearer. Backed by
 * `convex/http.ts:/web/harness/session-state/{claim,heartbeat,release,commit}`.
 */
import { type Harness } from "@mcpjam/sdk/host-config/internal";
import { logger } from "../logger.js";

export type HarnessOwnerType =
  | "direct-chat"
  | "chatbox-chat"
  | "eval-case"
  | "swarm-worker";

/** Owner-identifying fields sent on every session-state call. Spread into the
 *  claim/heartbeat/release/commit bodies, so `harnessId` (a lane-key dimension)
 *  reaches all four — this is what keeps a Codex turn from resuming a Claude Code
 *  lane (the backend keys by projectId, harnessId, ownerType, ownerKey). */
export type HarnessOwnerRef = {
  projectId: string;
  /** The harness running this turn — part of the lane key. */
  harnessId: Harness;
  ownerType: HarnessOwnerType;
  chatSessionId?: string;
  chatboxId?: string;
};

export type HarnessResumePayload = {
  harnessSessionId: string;
  resumeState: unknown;
  computerId: string;
};

/**
 * The resume-state commit for a chat-backed harness turn, committed ATOMICALLY
 * with the transcript through `/ingest-chat` (not the standalone endpoint) so
 * the product transcript and the runtime sidecar advance together. Carries no
 * `projectId`/`userId` — the ingest mutation supplies those from the resolved
 * request identity (the same dimensions it keys the transcript on).
 */
export type HarnessSessionCommitPayload = {
  ownerType: "direct-chat" | "chatbox-chat";
  chatSessionId: string;
  chatboxId?: string;
  leaseId: string;
  expectedStateVersion: number;
  harnessId: Harness;
  harnessSessionId: string;
  resumeState: unknown;
  computerId: string;
  runtimeFingerprint: string;
  /** Omit on a failed/skipped skills fetch so the stored hash is preserved. */
  skillsHash?: string;
};

export type HarnessClaimResult =
  | {
      ok: true;
      state: HarnessResumePayload | null;
      stateVersion: number;
      fingerprintChanged: boolean;
    }
  | { ok: false; status: number; error: string };

function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for harness session-state");
  }
  return convexHttpUrl;
}

async function postSessionState(
  pathSuffix: string,
  bearer: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<
  { ok: true; payload: any } | { ok: false; status: number; error: string }
> {
  const url = new URL(
    `/web/harness/session-state/${pathSuffix}`,
    getConvexHttpUrl()
  ).toString();
  const authorization = bearer.startsWith("Bearer ")
    ? bearer
    : `Bearer ${bearer}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    logger.error(`[harness-session-state] ${pathSuffix} network error`, err);
    return {
      ok: false,
      status: 502,
      error: "Failed to reach session-state endpoint",
    };
  }
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error: `session-state/${pathSuffix} returned ${response.status} with non-JSON body`,
    };
  }
  if (!response.ok || payload?.ok !== true) {
    return {
      ok: false,
      status: response.ok ? 502 : response.status,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : `session-state/${pathSuffix} failed (${response.status})`,
    };
  }
  return { ok: true, payload };
}

export async function claimHarnessSessionState(args: {
  owner: HarnessOwnerRef;
  runtimeFingerprint: string;
  /** Project-skills fingerprint; OMIT on a transient skills-fetch failure so the
   *  backend reuses the stored hash (no resume churn). "" means an empty project. */
  skillsHash?: string;
  leaseId: string;
  leasedBy: string;
  leaseTtlMs: number;
  bearer: string;
  signal?: AbortSignal;
}): Promise<HarnessClaimResult> {
  const res = await postSessionState(
    "claim",
    args.bearer,
    {
      ...args.owner,
      runtimeFingerprint: args.runtimeFingerprint,
      ...(args.skillsHash !== undefined ? { skillsHash: args.skillsHash } : {}),
      leaseId: args.leaseId,
      leasedBy: args.leasedBy,
      leaseTtlMs: args.leaseTtlMs,
    },
    args.signal
  );
  if (!res.ok) return res;
  return {
    ok: true,
    state: res.payload.state ?? null,
    stateVersion: Number(res.payload.stateVersion ?? 0),
    fingerprintChanged: Boolean(res.payload.fingerprintChanged),
  };
}

/**
 * Heartbeat outcome (never throws):
 *  - `ok`        — lease extended.
 *  - `lost`      — backend DEFINITIVELY says the lease is gone or owned by
 *                  another turn (200 with ok:false, or a 4xx). The caller must
 *                  abort: continuing would mutate a stolen session.
 *  - `retryable` — transient (network, timeout, 5xx, malformed body). The caller
 *                  should log and retry on the next tick, NOT abort on a blip.
 */
export type HarnessHeartbeatResult = "ok" | "lost" | "retryable";

export async function heartbeatHarnessSessionState(args: {
  owner: HarnessOwnerRef;
  leaseId: string;
  leaseTtlMs: number;
  bearer: string;
}): Promise<HarnessHeartbeatResult> {
  const res = await postSessionState("heartbeat", args.bearer, {
    ...args.owner,
    leaseId: args.leaseId,
    leaseTtlMs: args.leaseTtlMs,
  });
  if (res.ok) {
    // The request reached the endpoint; `extended` is the definitive answer.
    return res.payload?.extended === true ? "ok" : "lost";
  }
  // postSessionState maps network failures + malformed bodies to status 502.
  if (res.status >= 500) return "retryable";
  return "lost"; // definitive 4xx (e.g. membership/lease rejection)
}

export async function releaseHarnessSessionState(args: {
  owner: HarnessOwnerRef;
  leaseId: string;
  bearer: string;
}): Promise<void> {
  const res = await postSessionState("release", args.bearer, {
    ...args.owner,
    leaseId: args.leaseId,
  });
  if (!res.ok) {
    logger.warn("[harness-session-state] release failed", { error: res.error });
  }
}

export async function commitHarnessSessionState(args: {
  owner: HarnessOwnerRef;
  leaseId: string;
  expectedStateVersion: number;
  harnessSessionId: string;
  resumeState: unknown;
  computerId: string;
  runtimeFingerprint: string;
  /** Omit on a failed/skipped skills fetch so the stored hash is preserved. */
  skillsHash?: string;
  bearer: string;
}): Promise<boolean> {
  const res = await postSessionState("commit", args.bearer, {
    ...args.owner,
    leaseId: args.leaseId,
    expectedStateVersion: args.expectedStateVersion,
    harnessSessionId: args.harnessSessionId,
    resumeState: args.resumeState,
    computerId: args.computerId,
    runtimeFingerprint: args.runtimeFingerprint,
    ...(args.skillsHash !== undefined ? { skillsHash: args.skillsHash } : {}),
  });
  if (!res.ok) {
    logger.warn("[harness-session-state] commit failed", { error: res.error });
    return false;
  }
  return true;
}

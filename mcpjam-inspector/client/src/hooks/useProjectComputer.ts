import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";

/**
 * Client hooks for the Project Computers control plane (mcpjam-backend
 * `convex/projectComputers.ts`). The inspector references Convex functions by
 * string id (it does not import the backend's generated `api`).
 */

/** Provider-side lifecycle status surfaced by `getComputerStatus`. */
export type ComputerStatus =
  | "requested"
  | "provisioning"
  | "ready"
  | "waking"
  | "hibernating"
  | "deleting"
  | "deleted"
  | "error";

/** Why a computer is currently asleep, when the backend knows (COMP-7). */
export type ComputerHibernatedReason = "idle" | "billing";

export interface ComputerView {
  computerId: string;
  status: ComputerStatus;
  provider: string;
  lastError?: string;
  provisionedAt?: number;
  lastActiveAt?: number;
  /** The custom environment this computer boots from, if any (absent ⇒ base
   * image). See `computerEnvironments` / the Image picker. */
  environmentId?: string;
  /**
   * Why the machine is currently asleep, when known (COMP-7). Only meaningful
   * while `status === "hibernating"`. `"billing"` ⇒ paused because the compute
   * allowance ran out and the wallet couldn't cover the overage — waking it
   * would just bounce, so the UI shows the remedy instead. Absent (older
   * backends, or a clean idle sleep) ⇒ treat as inactivity.
   */
  hibernatedReason?: ComputerHibernatedReason;
}

export interface TerminalTokenResult {
  token: string;
  expiresAt: number;
  computerId: string;
  status: ComputerStatus;
}

/**
 * Org-level awake-time meter surfaced by `getComputerUsage`: settled awake
 * time for the current UTC month against the plan's free allowance, plus the
 * posted credits-per-hour rate. `allowanceMs: null` means unlimited hours.
 * `mode` is the deployment's billing posture — `off` means the backend isn't
 * metering and the UI should hide the meter.
 */
export interface ComputerUsageView {
  mode: "off" | "shadow" | "enforce";
  creditsPerHour: number;
  windowStartAt: number;
  resetsAt: number;
  awakeMs: number;
  allowanceMs: number | null;
  billedCredits: number;
  forgivenCredits: number;
  /**
   * COMP-7: true when the org has burned >= 80% of a finite allowance AND the
   * wallet can't absorb the overage that begins once it's exhausted — i.e. the
   * computer will pause for billing when the hours run out. Always false for
   * unlimited (enterprise) orgs. Optional so a backend predating this field
   * (or an older client) degrades to "no warning".
   */
  billingPauseWarning?: boolean;
}

/**
 * Live status of the caller's computer for a project, or `null` when they
 * have none (or it was deleted). `undefined` while the query loads or when
 * `projectId` is absent.
 */
export function useComputerStatus(
  projectId: string | null
): ComputerView | null | undefined {
  return useQuery(
    "projectComputers:getComputerStatus" as never,
    projectId ? ({ projectId } as never) : "skip"
  ) as ComputerView | null | undefined;
}

/**
 * The org's computer-time meter for a project, or `null` when the backend
 * can't resolve it. `undefined` while loading or when `projectId` is absent.
 * Throws during render (like any Convex query error) against a backend that
 * predates `getComputerUsage` — mount it behind an error boundary.
 */
export function useComputerUsage(
  projectId: string | null
): ComputerUsageView | null | undefined {
  return useQuery(
    "projectComputers:getComputerUsage" as never,
    projectId ? ({ projectId } as never) : "skip"
  ) as ComputerUsageView | null | undefined;
}

/** Reserve (provision-on-first-use / wake) the caller's computer. */
export function useReserveComputer(): (args: {
  projectId: string;
}) => Promise<ComputerView> {
  return useMutation("projectComputers:getOrReserveComputer" as never) as never;
}

/** Tear down the caller's computer for a project. */
export function useDeleteComputer(): (args: {
  projectId: string;
}) => Promise<{ deleted: boolean }> {
  return useMutation("projectComputers:deleteComputer" as never) as never;
}

/**
 * Manually hibernate the caller's `ready` computer (non-destructive; state is
 * preserved and the box auto-resumes on next use). Returns `{ hibernated:false }`
 * when there's no live machine to pause.
 */
export function useHibernateComputer(): (args: {
  projectId: string;
}) => Promise<{ hibernated: boolean }> {
  return useMutation("projectComputers:hibernateComputerNow" as never) as never;
}

/**
 * Mint a short-lived (~60s) terminal token authorizing a WebSocket to the
 * inspector server's terminal bridge. An ACTION (needs crypto.subtle).
 */
export function useMintTerminalToken(): (args: {
  projectId: string;
}) => Promise<TerminalTokenResult> {
  return useAction("projectComputers:mintTerminalToken" as never) as never;
}

/**
 * Which data plane serves this inspector (GET /api/web/computers/config):
 * itself (`localConfigured` — it holds the vendor key + secrets) or a
 * deployed one (`remoteDataPlaneUrl`). Neither ⇒ computers are unavailable
 * here and the UI should say so instead of offering a terminal that can't
 * connect.
 */
export interface ComputersDataPlaneConfig {
  localConfigured: boolean;
  remoteDataPlaneUrl: string | null;
}

// One fetch per page load — the answer is env-derived and can't change
// without a server restart.
let cachedDataPlaneConfig: ComputersDataPlaneConfig | null = null;

function parseDataPlaneConfig(value: unknown): ComputersDataPlaneConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.localConfigured !== "boolean") return null;
  return {
    localConfigured: record.localConfigured,
    remoteDataPlaneUrl:
      typeof record.remoteDataPlaneUrl === "string"
        ? record.remoteDataPlaneUrl
        : null,
  };
}

/** `undefined` while loading. On fetch failure assumes a local data plane —
 * the pre-config behavior, where the terminal WS surfaces the real error. */
export function useComputersDataPlaneConfig():
  | ComputersDataPlaneConfig
  | undefined {
  const [config, setConfig] = useState<ComputersDataPlaneConfig | undefined>(
    cachedDataPlaneConfig ?? undefined
  );

  useEffect(() => {
    if (cachedDataPlaneConfig) return;
    let cancelled = false;
    void fetch("/api/web/computers/config")
      .then((response) => (response.ok ? response.json() : null))
      .then((json: unknown) => {
        // Only cache real answers. The assume-local fallback below is
        // per-mount, so a transient /config failure can't pin the wrong
        // data plane for the rest of the SPA session.
        const parsed = parseDataPlaneConfig(json);
        if (parsed) cachedDataPlaneConfig = parsed;
        if (!cancelled) {
          setConfig(
            parsed ?? { localConfigured: true, remoteDataPlaneUrl: null }
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfig({ localConfigured: true, remoteDataPlaneUrl: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}

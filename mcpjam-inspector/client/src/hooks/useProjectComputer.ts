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

export interface ComputerView {
  computerId: string;
  status: ComputerStatus;
  provider: string;
  lastError?: string;
  provisionedAt?: number;
  lastActiveAt?: number;
}

export interface TerminalTokenResult {
  token: string;
  expiresAt: number;
  computerId: string;
  status: ComputerStatus;
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

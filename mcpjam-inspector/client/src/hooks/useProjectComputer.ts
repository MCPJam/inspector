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

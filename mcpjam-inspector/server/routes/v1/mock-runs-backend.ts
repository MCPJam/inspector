/**
 * The backend functions behind a mock's test runs (B6): the one place the
 * Inspector names them. Each is called with the caller's own bearer; the
 * backend binds a run to the person who opened it and rechecks their project
 * access on every use.
 */
import { makeFunctionReference } from "convex/server";
import { createConvexClient } from "./convex-client.js";

const fn = {
  open: makeFunctionReference<"mutation">("mockRuns:open"),
  reset: makeFunctionReference<"mutation">("mockRuns:reset"),
  close: makeFunctionReference<"mutation">("mockRuns:close"),
};

/** What `open` and `reset` answer. `mcpPath` is the run's URL path and query, on the Inspector's own origin. */
export interface BackendRun {
  runId: string;
  version: number;
  epoch: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  mcpPath: string;
}

export const openRun = (
  token: string,
  args: { mockId: string; version?: number; platformRunId?: string },
): Promise<BackendRun> => createConvexClient(token).mutation(fn.open, args);

export const resetRun = (token: string, args: { runId: string; expectedEpoch: number }): Promise<BackendRun> =>
  createConvexClient(token).mutation(fn.reset, args);

export const closeRun = (token: string, args: { runId: string }): Promise<{ closed: true }> =>
  createConvexClient(token).mutation(fn.close, args);

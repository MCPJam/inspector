import { makeFunctionReference } from "convex/server";

export type ProjectClientComparison = {
  state: "pending" | "complete" | "skipped";
  /** Live comparison clients, lead first. */
  hostIds: string[];
  /** True only on the call that created the lineup. */
  created: boolean;
};

export type EnsureProjectClientResult = {
  hostId: string;
  created: boolean;
  /** Null unless `initializeComparison` was requested. */
  comparison: ProjectClientComparison | null;
};

/**
 * Open to every project role and idempotent: gives an empty project its
 * default client. `initializeComparison` (admins only) also settles the
 * first-run comparison lineup. One reference for the browser and the v1 list
 * route, so their view of the arguments and the result cannot drift.
 */
export const ensureProjectClientMutation = makeFunctionReference<
  "mutation",
  {
    projectId: string;
    themeMode?: "light" | "dark";
    initializeComparison?: boolean;
  },
  EnsureProjectClientResult
>("projectClients:ensureProjectClient");

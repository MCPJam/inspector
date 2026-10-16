import { makeFunctionReference } from "convex/server";

/**
 * Open to every project role and idempotent: gives an empty project its
 * default client. One reference for the browser and the v1 list route, so
 * their view of the arguments and the result cannot drift.
 */
export const ensureProjectClientMutation = makeFunctionReference<
  "mutation",
  { projectId: string; themeMode?: "light" | "dark" },
  { hostId: string; created: boolean }
>("projectClients:ensureProjectClient");

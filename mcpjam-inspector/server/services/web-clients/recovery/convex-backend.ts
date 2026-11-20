/**
 * The reconnect backend over Convex: public functions in the backend's
 * `webClients` module, called with the bearer of whoever acts (the run's
 * launcher for a report, the admin who signed in for a handback). The backend
 * decides who may do what; this file only maps names and shapes, so a change
 * to a backend signature is an edit here and nowhere else.
 */
import type { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { WebReconnectBackend } from "./backend.js";

type Name = keyof WebReconnectBackend;
type Args<K extends Name> = Parameters<WebReconnectBackend[K]>[0];
type Result<K extends Name> = Awaited<ReturnType<WebReconnectBackend[K]>>;

const query = <K extends Name>(name: K) =>
  makeFunctionReference<"query", Args<K>, Result<K>>(`webClients:${name}`);
const mutation = <K extends Name>(name: K) =>
  makeFunctionReference<"mutation", Args<K>, Result<K>>(`webClients:${name}`);

/** `convex` carries the acting person's bearer, as `createConvexClient` sets it. */
export function createConvexWebReconnectBackend(
  convex: Pick<ConvexHttpClient, "query" | "mutation">,
): WebReconnectBackend {
  return {
    listWebAccounts: (args) => convex.query(query("listWebAccounts"), args),
    listWebReconnectRequests: (args) =>
      convex.query(query("listWebReconnectRequests"), args),
    markWebAccountVerified: (args) =>
      convex.mutation(mutation("markWebAccountVerified"), args),
    markWebAccountNeedsSignIn: (args) =>
      convex.mutation(mutation("markWebAccountNeedsSignIn"), args),
    saveWebAccountProfile: (args) =>
      convex.mutation(mutation("saveWebAccountProfile"), args),
    reportWebSignInRequired: (args) =>
      convex.mutation(mutation("reportWebSignInRequired"), args),
    markWebReconnectNotified: (args) =>
      convex.mutation(mutation("markWebReconnectNotified"), args),
    handbackWebReconnect: (args) =>
      convex.mutation(mutation("handbackWebReconnect"), args),
    claimResumableWebRuns: (args) =>
      convex.mutation(mutation("claimResumableWebRuns"), args),
  };
}

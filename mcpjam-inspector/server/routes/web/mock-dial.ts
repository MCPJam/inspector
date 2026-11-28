/**
 * What a route hands the in-process mock dispatch so a mock can be dialed as
 * the saved server it is: the caller's own auth context and a way to authorize
 * the same mock again for a fresh grant. Shared by every route that dials a
 * saved server outside the connection manager (the doctor, conformance).
 */
import type { Context } from "hono";
import type { MockDial } from "../../utils/mock-servers.js";
import { authorizeServer, callerContextFromHono } from "./auth.js";

/** The access fields a route authorized the server with; a renewal repeats them. */
export interface MockDialAccess {
  accessScope?: "project_member" | "chat_v2";
  scenarioId?: string;
  accessVersion?: number;
}

export function mockDialForRequest(
  c: Context,
  bearerToken: string,
  projectId: string,
  serverId: string,
  access: MockDialAccess = {},
): MockDial {
  return {
    caller: callerContextFromHono(c),
    bearerToken,
    projectId,
    reauthorize: () => authorizeServer(c, bearerToken, projectId, serverId, access),
  };
}

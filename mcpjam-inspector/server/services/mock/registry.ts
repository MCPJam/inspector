/**
 * How MCPJam's own dialers reach the mock route without a network hop.
 *
 * The route sets its handler here where it is mounted (`routes/web/index.ts`,
 * which the hosted build, `npx` and the desktop app all use). A dialer imports
 * only this file, never the route, so the route's imports cannot make a cycle.
 *
 * The door is the call's last argument: the grant the dialer holds and the
 * auth context it just authorized with. The route honors a grant only with
 * that context. Nothing here is reachable over HTTP.
 */
import type {
  createAuthorizedManager,
  ManagerCallerContext,
} from "../../routes/web/auth.js";

type ManagerOptions = NonNullable<Parameters<typeof createAuthorizedManager>[7]>;

/** The client profile the dialer connected with, so the real server sees the same one. */
export interface MockDialProfile {
  timeoutMs: number;
  clientCapabilities?: Record<string, unknown>;
  initializePins?: ManagerOptions["initializePins"];
  xaaIssuer?: string;
}

export interface MockDoorContext {
  /** The grant the backend minted for this dialer; never sent over a wire. */
  grant: string;
  /** What the dialer authorized with: the bearer and who it acts as. */
  bearerToken: string;
  caller: ManagerCallerContext;
  projectId: string;
  profile: MockDialProfile;
  /** The eval run this call belongs to, when the dialer knows it. */
  runKey?: string;
}

export type MockInProcessHandler = (
  mockId: string,
  request: Request,
  door: MockDoorContext,
) => Promise<Response>;

let handler: MockInProcessHandler | undefined;

export const registerMockInProcessHandler = (next: MockInProcessHandler) => {
  handler = next;
};
export const getMockInProcessHandler = () => handler;

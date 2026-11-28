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
import type { ManagerCallerContext } from "../../routes/web/auth.js";
import type { MockCallMark } from "../../../shared/mock-answer-span.js";

/** The client profile the dialer connected with, so the real server sees the same one. */
export interface MockDialProfile {
  timeoutMs: number;
  clientCapabilities?: Record<string, unknown>;
  initializePins?: Record<string, unknown>;
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
  /** Receives each call's provenance as the call settles, so a streamed answer is marked too. */
  onCall?: (mark: MockCallMark) => void;
}

export type MockInProcessHandler = (
  mockId: string,
  request: Request,
  door: MockDoorContext,
) => Promise<Response>;

let handler: MockInProcessHandler | undefined;

export const registerMockInProcessHandler = (next: MockInProcessHandler | undefined) => {
  handler = next;
};
export const getMockInProcessHandler = () => handler;

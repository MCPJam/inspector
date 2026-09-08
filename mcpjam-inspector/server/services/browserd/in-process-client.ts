/**
 * The daemon, with the socket removed.
 *
 * The hosted engine runs `mcpjam-browserd` as a process inside an E2B desktop
 * and talks to it over HTTP. The local and Electron engines run the very same
 * stack — same queue, same lease, same request handler, same driver — inside
 * the inspector server, where a port would be a liability rather than a
 * feature: an open browser-driving endpoint on a developer's laptop, bound to
 * whatever interface, protected by a bearer nobody rotates.
 *
 * So the transport is a function call. `buildBrowserdStack` already builds a
 * handler that takes a parsed request and returns a parsed response and never
 * listens; this adapts that to the same `SessionClient` the hosted path uses,
 * decoding replies through `browserd-codec.ts` so both engines agree exactly
 * what a reply means.
 *
 * WHAT THIS IS NOT: a way around the daemon's rules. Every command still goes
 * through the auth check, the lease gate, the bootId check and the idempotent
 * queue. Bypassing the handler and calling the driver directly would be
 * shorter and would silently drop all four — including the gate that keeps a
 * screenshot out of a trace while someone types their password.
 */
import type { BrowserdStack } from "./daemon/server";
import type { BrowserCommand } from "./protocol";
import {
  asRecord,
  decodeCommandResponse,
  decodeHealth,
  decodeLease,
  decodeLeaseAction,
  decodeStatus,
  type BrowserdCommandResponse,
  type BrowserdHealth,
  type BrowserdLeaseState,
  type BrowserdStatus,
} from "./browserd-codec";

/** What the hosted client exposes, satisfied here without a socket. */
export interface InProcessBrowserdClient {
  health(): Promise<BrowserdHealth>;
  status(): Promise<BrowserdStatus>;
  lease(): Promise<BrowserdLeaseState>;
  leaseAction(args: {
    action: "acquire" | "heartbeat" | "resume";
    holder: string;
    ttlMs?: number;
    kind?: "human" | "script";
  }): Promise<{ took: boolean; lease: BrowserdLeaseState }>;
  sendCommand(
    command: BrowserCommand,
    expectedBootId?: string,
  ): Promise<BrowserdCommandResponse>;
}

export function createInProcessBrowserdClient(
  stack: Pick<BrowserdStack, "handler">,
  token: string,
): InProcessBrowserdClient {
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await stack.handler.handle({
      method,
      path,
      // No Origin, ever. The handler rejects any request that carries one as a
      // DNS-rebinding attempt, and an in-process caller genuinely has none —
      // sending a synthetic value to "look like a browser" would be inventing
      // the exact header the check exists to catch.
      origin: undefined,
      authorization: `Bearer ${token}`,
      body: body === undefined ? "" : JSON.stringify(body),
    });
    return { status: response.status, body: asRecord(response.body) };
  };

  return {
    async health() {
      return decodeHealth(await call("GET", "/healthz"));
    },
    async status() {
      return decodeStatus(await call("GET", "/v1/status"));
    },
    async lease() {
      return decodeLease(await call("GET", "/v1/lease"));
    },
    async leaseAction(args) {
      return decodeLeaseAction(await call("POST", "/v1/lease", args));
    },
    async sendCommand(command, expectedBootId) {
      return decodeCommandResponse(
        await call("POST", "/v1/commands", { command, expectedBootId }),
      );
    },
  };
}

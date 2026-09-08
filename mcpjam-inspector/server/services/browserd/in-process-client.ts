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
import type { BrowserLedgerEntry } from "./daemon/command-ledger";
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

/** A non-200 from the daemon is a failure, not an empty answer. */
function assertOk(
  response: { status: number; body: Record<string, unknown> },
  path: string,
): void {
  if (response.status === 200) return;
  const error =
    typeof response.body.error === "string" ? response.body.error : "unknown";
  throw new Error(`browserd ${path} answered ${response.status}: ${error}`);
}

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
  /** Read the command ledger forward from a cursor. */
  readTrace(args?: {
    afterSeq?: number;
    commandId?: string;
    limit?: number;
  }): Promise<{ entries: BrowserLedgerEntry[]; headSeq: number }>;
  /**
   * Record a command the INSPECTOR refused, so the daemon's ring stays the one
   * ordered ledger with one seq minter. Nothing is sent to the browser.
   */
  recordRefusal(args: {
    command: BrowserCommand;
    errorCode: string;
    durationMs?: number;
  }): Promise<{ seq: number }>;
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
    // Split the query the way the http adapter's `new URL(...)` does. The
    // handler matches `req.path` EXACTLY and reads arguments from `req.query`,
    // so passing "/v1/trace?afterSeq=3" whole would 404 a route that exists —
    // and a caller has no way to tell that apart from a daemon too old to
    // serve it.
    const queryStart = path.indexOf("?");
    const pathname = queryStart === -1 ? path : path.slice(0, queryStart);
    const query =
      queryStart === -1
        ? undefined
        : new URLSearchParams(path.slice(queryStart + 1));
    const response = await stack.handler.handle({
      method,
      path: pathname,
      // No Origin, ever. The handler rejects any request that carries one as a
      // DNS-rebinding attempt, and an in-process caller genuinely has none —
      // sending a synthetic value to "look like a browser" would be inventing
      // the exact header the check exists to catch.
      origin: undefined,
      authorization: `Bearer ${token}`,
      body: body === undefined ? "" : JSON.stringify(body),
      ...(query ? { query } : {}),
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
    async readTrace(args = {}) {
      const query = new URLSearchParams();
      if (args.afterSeq !== undefined) query.set("afterSeq", String(args.afterSeq));
      if (args.commandId !== undefined) query.set("commandId", args.commandId);
      if (args.limit !== undefined) query.set("limit", String(args.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      const response = await call("GET", `/v1/trace${suffix}`);
      // THROWN, not smoothed into an empty page. A 501 means this daemon keeps
      // no ledger and a 401 means the credential is wrong; answering both with
      // "no rows" tells a caller its history is empty, which is the one thing
      // it must not conclude from a failure to read it.
      assertOk(response, "/v1/trace");
      const entries = response.body.entries;
      return {
        entries: Array.isArray(entries) ? (entries as BrowserLedgerEntry[]) : [],
        headSeq:
          typeof response.body.headSeq === "number" ? response.body.headSeq : 0,
      };
    },
    async recordRefusal(args) {
      const response = await call("POST", "/v1/trace", args);
      // Likewise: a refusal that was not recorded is a hole in the trace, and
      // the door turns this rejection into the caller's `historyWarning`.
      assertOk(response, "/v1/trace");
      return {
        seq: typeof response.body.seq === "number" ? response.body.seq : 0,
      };
    },
  };
}

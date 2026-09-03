/**
 * The thin Node-http adapter for browserd's control plane.
 *
 * All routing, auth, and outcome logic lives in `BrowserdRequestHandler` (pure,
 * unit-tested). This file does only what a socket forces: parse the request,
 * enforce a body-size limit, call the handler, and write the JSON response. It
 * also assembles the full daemon stack from a `BrowserDriver` — mint the
 * per-boot id, build the command queue with the staleness-guarded executor, and
 * hand both to the handler — and emits the stdout ready-line the boot recipe
 * (PR c) waits on.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { CommandQueue } from "./command-queue";
import { BrowserdRequestHandler, type DaemonResponse } from "./request-handler";
import { guardLease, guardStaleness, type BrowserDriver } from "./browser-driver";
import { HandoffLease } from "./lease";

/** Requests bigger than this are refused with 413 before they reach the queue. */
const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {}

function readRequestBody(
  req: import("node:http").IncomingMessage,
  limitBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > limitBytes) {
        refused = true;
        // Pause rather than destroy: destroying the socket would deny the caller
        // the 413 it is owed. Pausing stops accumulation while the response stays
        // writable; the caller closes the socket once the refusal has flushed.
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeResponse(
  res: import("node:http").ServerResponse,
  response: DaemonResponse,
): void {
  if (response.body === undefined) {
    res.writeHead(response.status, {
      "content-length": "0",
      ...response.headers,
    });
    res.end();
    return;
  }
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...response.headers,
  });
  res.end(payload);
}

export interface DaemonServerOptions {
  bodyLimitBytes?: number;
}

/** Bind a request handler to a Node http server. Does not call `listen`. */
export function createDaemonServer(
  handler: BrowserdRequestHandler,
  options: DaemonServerOptions = {},
): Server {
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  return createServer((req, res) => {
    void (async () => {
      let path: string;
      try {
        path = new URL(req.url ?? "/", "http://browserd.invalid").pathname;
      } catch {
        writeResponse(res, { status: 404 });
        return;
      }
      let body = "";
      if (req.method === "POST" || req.method === "PUT") {
        try {
          body = await readRequestBody(req, bodyLimit);
        } catch (error) {
          writeResponse(res, {
            status: error instanceof BodyTooLargeError ? 413 : 400,
          });
          return;
        }
      }
      const response = await handler.handle({
        method: req.method ?? "GET",
        path,
        origin: headerValue(req.headers.origin),
        authorization: headerValue(req.headers.authorization),
        body,
      });
      writeResponse(res, response);
    })().catch(() => {
      if (!res.headersSent) writeResponse(res, { status: 500 });
      else res.end();
    });
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface BrowserdStack {
  server: Server;
  handler: BrowserdRequestHandler;
  queue: CommandQueue;
  bootId: string;
  /** The human-handoff lease this stack's handler and driver share. */
  lease: HandoffLease;
}

/**
 * Assemble the whole daemon around a driver: one bootId shared by the queue and
 * the handler, the queue driven by the staleness-guarded executor, and the http
 * server bound to the handler. The caller (`PR c` entrypoint) then `listen`s and
 * prints the ready-line.
 */
export function buildBrowserdStack(
  driver: BrowserDriver,
  config: {
    token: string;
    bootId?: string;
    lease?: HandoffLease;
  } & DaemonServerOptions,
): BrowserdStack {
  const bootId = config.bootId ?? randomUUID();
  // ONE lease instance, shared THREE ways: the handler refuses commands that
  // arrive while it is held, the queue's executor re-refuses the ones already
  // admitted when it is taken, and the driver reads it both to refuse a
  // capture mid-command and to make the first post-handoff observation loud
  // (L6). Two instances would let those disagree — which, for a gate whose
  // whole job is privacy, means a screenshot of someone's password field.
  const lease = config.lease ?? new HandoffLease();
  // The lease check wraps the staleness guard rather than the other way round:
  // reading a tab's current state token to compare it IS an observation of the
  // page, so it must not happen for a command the lease is about to refuse.
  const queue = new CommandQueue(
    guardLease(lease, guardStaleness(driver, lease)),
    bootId,
  );
  const handler = new BrowserdRequestHandler({
    queue,
    driver,
    bootId,
    token: config.token,
    lease,
  });
  const server = createDaemonServer(handler, {
    bodyLimitBytes: config.bodyLimitBytes,
  });
  return { server, handler, queue, bootId, lease };
}

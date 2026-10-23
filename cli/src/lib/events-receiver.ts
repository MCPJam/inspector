/**
 * The local webhook receiver behind `mcpjam events watch --mode webhook`.
 *
 * A plain-http listener that routes `POST /i/{inboxId}/s/{slotId}` into a
 * `MemoryEventInbox` with the RAW request bytes — nothing is parsed or
 * re-serialized before the inbox verifies the Standard Webhooks signature, so
 * what is verified is exactly what the server signed. Every acceptance rule
 * (the C3 table: pending/active/removed/expired slots, 401 on a bad or stale
 * signature, challenge echo only when correctly signed) is the inbox's, not
 * this file's.
 *
 * The listener itself is always plain http. It is CONFORMANT only when the
 * callback URL the server is given is an https origin that forwards here (a
 * tunnel terminating TLS); pointing a server straight at this http listener is
 * the labelled `--insecure-local-receiver` development mode.
 *
 * Routing ids are not credentials (contract C3), so they may appear in status
 * lines; the secret never enters this file.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  MAX_DELIVERY_BODY_BYTES,
  type MemoryEventInbox,
  type ReceiveResult,
} from "@mcpjam/sdk/events";

/** `/i/{inboxId}/s/{slotId}`, optionally behind a path prefix a tunnel kept. */
const DELIVERY_PATH = /(?:^|\/)i\/([a-z2-7]+)\/s\/([a-z2-7]+)\/?$/;

export interface ReceiverDelivery {
  slotId: string;
  status: number;
  /** The inbox answered a verification challenge. */
  challenge: boolean;
  /** The inbox's rejection reason, for a non-2xx answer. */
  reason?: string;
}

export interface EventsReceiverHandle {
  /** `http://host:port` the listener is bound to. */
  localUrl: string;
  host: string;
  port: number;
  /** Route deliveries into this inbox. Until set, deliveries get `503`. */
  attach(inbox: MemoryEventInbox): void;
  close(): Promise<void>;
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function flattenHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") flat[key] = value;
    else if (Array.isArray(value)) flat[key] = value.join(", ");
  }
  return flat;
}

export async function startEventsReceiver(args: {
  host: string;
  port: number;
  onDelivery?: (delivery: ReceiverDelivery) => void;
}): Promise<EventsReceiverHandle> {
  let inbox: MemoryEventInbox | undefined;

  const server = http.createServer((req, res) => {
    const respond = (
      status: number,
      body?: unknown,
      headers: Record<string, string> = {},
    ) => {
      if (res.headersSent) return;
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };

    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && path === "/.well-known/mcp-webhook-receiver.json") {
      // Receiver consent method (d) of the draft, as the hosted inbox serves it.
      respond(200, { receivers: ["/i/"] });
      return;
    }
    const match = DELIVERY_PATH.exec(path);
    if (req.method !== "POST" || !match) {
      respond(404, { error: "not_found" });
      return;
    }
    if (!inbox) {
      respond(503, { error: "receiver_not_ready" }, { "retry-after": "1" });
      return;
    }
    if (match[1] !== inbox.inboxId) {
      respond(410, { error: "unknown_inbox" });
      return;
    }
    const slotId = match[2]!;
    const target = inbox;

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_DELIVERY_BODY_BYTES) {
        // Stop buffering; a 413 is final for a conforming sender.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => respond(400, { error: "bad_request" }));
    req.on("end", () => {
      if (tooLarge) {
        args.onDelivery?.({ slotId, status: 413, challenge: false, reason: "body_too_large" });
        respond(413, { error: "body_too_large" }, { connection: "close" });
        return;
      }
      target
        .receive({
          slotId,
          headers: flattenHeaders(req.headers),
          body: new Uint8Array(Buffer.concat(chunks)),
        })
        .then((result: ReceiveResult) => {
          const body = result.body as Record<string, unknown> | undefined;
          const challenge =
            result.status === 200 &&
            typeof body === "object" &&
            body !== null &&
            "challenge" in body;
          const reason =
            result.status >= 300 && typeof body?.error === "string"
              ? body.error
              : undefined;
          args.onDelivery?.({
            slotId,
            status: result.status,
            challenge,
            ...(reason ? { reason } : {}),
          });
          respond(result.status, result.body, result.headers);
        })
        .catch(() => respond(500, { error: "internal" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(args.port, args.host);
  });
  const address = server.address() as AddressInfo;
  const host = args.host;
  const port = address.port;

  return {
    localUrl: `http://${formatHost(host)}:${port}`,
    host,
    port,
    attach(next) {
      inbox = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

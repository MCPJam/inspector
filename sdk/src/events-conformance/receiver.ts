/**
 * The webhook receiver an events conformance run delivers to (Node only).
 *
 * A conformance run needs a callback URL the server under test can reach and
 * a receiver that can do things a production inbox never does on purpose:
 * refuse a challenge, answer with a redirect, and record the RAW shape of
 * every request (headers, size) for the delivery-profile checks. Everything
 * else — slots, signature verification, the C3 acceptance table, the journal
 * — is `MemoryEventInbox`, the same rules the Durable Object implements.
 *
 * TLS: the draft makes `https` a MUST, so pass `tls: {cert, key}` (or front
 * the receiver with an https tunnel and pass `publicOrigin`). A plain-http
 * receiver is allowed only as a LABELLED override: the run reports
 * `overrides: ["insecure-local-receiver"]` and can never pass.
 */

import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { MemoryEventInbox } from "../events/memory-inbox.js";

export interface ReceiverObservation {
  path: string;
  slotId?: string;
  method: string;
  status: number;
  at: number;
  contentType?: string;
  webhookId?: string;
  subscriptionIdHeader?: string;
  bodyBytes: number;
  /** `type` of a control body, or `"event"` — never the body itself. */
  bodyKind?: string;
  /** For events: the body's `eventId`, to compare with `webhook-id`. */
  eventId?: string;
}

export interface EventsConformanceReceiver {
  inbox: MemoryEventInbox;
  /** The origin callback URLs are minted under. */
  origin: string;
  insecure: boolean;
  observations: ReceiverObservation[];
  /** Answer this slot's verification with the WRONG challenge. */
  refuseChallenge(slotId: string): void;
  /** Answer every request to this slot with a 307 to a trap path. */
  redirect(slotId: string): void;
  /** Requests that followed a redirect into the trap. */
  redirectHits: string[];
  close(): Promise<void>;
}

export async function startEventsConformanceReceiver(options: {
  tls?: { cert: string; key: string };
  host?: string;
  port?: number;
  /** Public https origin when the receiver sits behind a tunnel. */
  publicOrigin?: string;
} = {}): Promise<EventsConformanceReceiver> {
  const observations: ReceiverObservation[] = [];
  const refusing = new Set<string>();
  const redirecting = new Set<string>();
  const redirectHits: string[] = [];
  let inbox!: MemoryEventInbox;

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = req.url ?? "/";
      const body = Buffer.concat(chunks);
      const header = (name: string) => {
        const value = req.headers[name];
        return typeof value === "string" ? value : undefined;
      };
      const observation: ReceiverObservation = {
        path,
        method: req.method ?? "GET",
        status: 0,
        at: Date.now(),
        ...(header("content-type") ? { contentType: header("content-type")! } : {}),
        ...(header("webhook-id") ? { webhookId: header("webhook-id")! } : {}),
        ...(header("x-mcp-subscription-id")
          ? { subscriptionIdHeader: header("x-mcp-subscription-id")! }
          : {}),
        bodyBytes: body.length,
      };
      try {
        const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
        observation.bodyKind = typeof parsed.type === "string" ? parsed.type : "event";
        if (typeof parsed.eventId === "string") observation.eventId = parsed.eventId;
      } catch {
        // Not JSON: recorded by size only.
      }
      const respond = (status: number, payload?: unknown, headers?: Record<string, string>) => {
        observation.status = status;
        observations.push(observation);
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      };
      if (path.startsWith("/redirect-trap/")) {
        redirectHits.push(path);
        respond(200, { challenge: "trap" });
        return;
      }
      const match = /^\/i\/([a-z2-7]+)\/s\/([a-z2-7]+)$/.exec(path);
      if (req.method !== "POST" || !match || match[1] !== inbox.inboxId) {
        respond(404, { error: "not_found" });
        return;
      }
      const slotId = match[2]!;
      observation.slotId = slotId;
      if (redirecting.has(slotId)) {
        respond(307, undefined, { location: `/redirect-trap/${slotId}` });
        return;
      }
      if (refusing.has(slotId) && observation.bodyKind === "verification") {
        respond(200, { challenge: "not-the-challenge" });
        return;
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers[key] = value;
      }
      inbox
        .receive({ slotId, headers, body: new Uint8Array(body) })
        .then((result) => respond(result.status, result.body, result.headers))
        .catch(() => respond(500, { error: "internal" }));
    });
  };

  const server = options.tls
    ? https.createServer({ cert: options.tls.cert, key: options.tls.key }, handler)
    : http.createServer(handler);
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve)
  );
  const { port } = server.address() as AddressInfo;
  const origin =
    options.publicOrigin?.replace(/\/$/, "") ??
    `${options.tls ? "https" : "http"}://${options.host ?? "127.0.0.1"}:${port}`;
  inbox = new MemoryEventInbox({ publicOrigin: origin });
  return {
    inbox,
    origin,
    insecure: !origin.startsWith("https://"),
    observations,
    refuseChallenge: (slotId) => refusing.add(slotId),
    redirect: (slotId) => redirecting.add(slotId),
    redirectHits,
    close: () =>
      new Promise<void>((resolve) => {
        (server as http.Server).closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

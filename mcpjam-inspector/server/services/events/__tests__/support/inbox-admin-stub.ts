/**
 * A local HTTP stand-in for the inbox Worker's C5 ADMIN API, backed by the
 * SDK's `MemoryEventInbox`. Lets the hosted `HttpInboxClient` be exercised
 * over a real socket — status codes, headers, JSON bodies — against the same
 * rules the in-memory inbox enforces.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  InboxBackpressureError,
  MemoryEventInbox,
} from "@mcpjam/sdk/events";

export const STUB_ADMIN_TOKEN = "stub-admin-token-0123456789abcdef0123456789";

export interface InboxAdminStub {
  url: string;
  memory: MemoryEventInbox;
  /** Answer the next N appends with `503` + `Retry-After`. */
  applyBackpressure(times: number, retryAfterSeconds?: number): void;
  /** Requests seen, without bodies. */
  requests: Array<{ method: string; path: string; adminToken?: string }>;
  viewerEpoch: number;
  close(): Promise<void>;
}

export async function startInboxAdminStub(options: {
  clock?: { now(): number };
  inboxId?: string;
  publicOrigin?: string;
} = {}): Promise<InboxAdminStub> {
  // Assigned once the socket is listening: the public receiver's callback
  // URLs are minted under this server's own origin.
  let memory!: MemoryEventInbox;
  let backpressure = 0;
  let retryAfter = 5;
  const requests: InboxAdminStub["requests"] = [];
  const handle: InboxAdminStub = {
    url: "",
    memory: undefined as unknown as MemoryEventInbox,
    requests,
    viewerEpoch: 1,
    applyBackpressure(times, retryAfterSeconds = 5) {
      backpressure = times;
      retryAfter = retryAfterSeconds;
    },
    close: async () => {},
  };

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBytes = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://stub");

    // The PUBLIC receiver (`POST /i/{inboxId}/s/{slotId}`): raw bytes to the
    // inbox's C3 acceptance table, no admin token.
    const deliver = /^\/i\/([^/]+)\/s\/([^/]+)$/.exec(url.pathname);
    if (deliver && req.method === "POST") {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
      }
      const result = await memory.receive({
        slotId: deliver[2]!,
        headers,
        body: new Uint8Array(rawBytes),
      });
      res.writeHead(result.status, {
        "content-type": "application/json",
        ...(result.headers ?? {}),
      });
      res.end(JSON.stringify(result.body ?? {}));
      return;
    }

    const raw = rawBytes.toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, any>) : {};
    const token = req.headers["x-events-inbox-admin-token"];
    requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      ...(typeof token === "string" ? { adminToken: token } : {}),
    });
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    if (token !== STUB_ADMIN_TOKEN) return send(401, { error: "unauthorized" });

    const match = /^\/admin\/i\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return send(404, { error: "not_found" });
    const rest = match[2] ?? "";
    try {
      if (rest === "slots" && req.method === "POST") {
        const allocation =
          body.recoverOnly === true
            ? await memory.findAllocation(body.idempotencyKey)
            : await memory.allocateSlot({
                logicalSubscriptionId: body.logicalSubscriptionId,
                projectId: body.projectId,
                environmentId: body.environmentId ?? null,
                bindingKey: body.bindingKey,
                dispatch: body.dispatch === true,
                idempotencyKey: body.idempotencyKey,
              });
        if (!allocation) return send(404, { error: "unknown_allocation" });
        return send(200, {
          slotId: allocation.slotId,
          callbackUrl: allocation.callbackUrl,
          secret: allocation.secret,
          state: allocation.state,
          pendingExpiresAt: 0,
        });
      }
      if (rest === "append" && req.method === "POST") {
        if (backpressure > 0) {
          backpressure -= 1;
          return send(503, { error: "inbox_backpressure" }, { "retry-after": String(retryAfter) });
        }
        try {
          return send(200, await memory.append(body as never));
        } catch (error) {
          if (error instanceof InboxBackpressureError) {
            return send(503, { error: "inbox_backpressure" }, { "retry-after": "5" });
          }
          throw error;
        }
      }
      if (rest === "viewer-epoch") {
        if (req.method === "POST") handle.viewerEpoch += 1;
        return send(200, { epoch: handle.viewerEpoch });
      }
      const slot = /^slots\/([^/]+)\/([a-z-]+)$/.exec(rest);
      if (slot) {
        const [, slotId, action] = slot as unknown as [string, string, string];
        if (!memory.slotState(slotId)) return send(404, { error: "unknown_slot" });
        switch (action) {
          case "secret":
            return send(200, await memory.getSecret(slotId));
          case "reconcile":
            return send(200, await memory.reconcile(slotId, body.serverSubscriptionId));
          case "unbind":
            await memory.unbind(slotId);
            return send(200, { state: "pending" });
          case "rotate":
            return send(200, { ...(await memory.rotate(slotId)), previousExpiresAt: 0 });
          case "retire-previous":
            await memory.retirePrevious(slotId);
            return send(200, {});
          case "remove":
            await memory.remove(slotId);
            return send(200, {});
          case "dispatch":
            return send(200, {});
          case "state":
            return send(200, {
              slotId,
              ...memory.slotState(slotId),
              counts: { deliveries: 0 },
              rejections: memory.rejections.filter((r) => r.slotId === slotId),
            });
        }
      }
      return send(404, { error: "not_found" });
    } catch {
      return send(500, { error: "stub_failure" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  handle.url = `http://127.0.0.1:${port}`;
  memory = new MemoryEventInbox({
    publicOrigin: options.publicOrigin ?? handle.url,
    ...(options.inboxId ? { inboxId: options.inboxId } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  handle.memory = memory;
  handle.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return handle;
}

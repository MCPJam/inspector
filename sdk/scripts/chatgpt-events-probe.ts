/**
 * Phase 0 — ChatGPT MCP Events observation probe.
 *
 * An instrumented events server on the official `@modelcontextprotocol/server`
 * SDK. Deploy it behind a public HTTPS URL, connect it to ChatGPT as a plugin,
 * ask ChatGPT to monitor `probe.ping`, and it records — with dates, and never
 * a secret — exactly what ChatGPT does:
 *
 *   - which capability placement it read and which protocol version it spoke;
 *   - `events/list` / `events/subscribe` parameters: `ttlMs` (value, null or
 *     omitted), secret LENGTH (decoded bytes only), cursor, callback URL SHAPE
 *     (id segments replaced);
 *   - refresh cadence against the `refreshBefore` this probe grants;
 *   - whether it unsubscribes when the chat/automation ends;
 *   - its answer to the verification challenge;
 *   - its responses to deliveries we control: valid, bad signature, stale
 *     timestamp, duplicate id, oversize body (`POST /probe/deliver`).
 *
 * Not observable (so MCPJam policy in the profile instead): ChatGPT's
 * retention, internal prompting, and retry/suspension internals.
 *
 * Usage:
 *   PROBE_TOKEN=… npx tsx scripts/chatgpt-events-probe.ts --port 8787 \
 *     --out ./chatgpt-probe.ndjson [--grant-ms 600000]
 *   curl -X POST -H "x-probe-token: $PROBE_TOKEN" \
 *     "https://<public>/probe/deliver?variant=valid|bad-signature|stale-timestamp|duplicate|oversize"
 *   npx tsx scripts/chatgpt-events-probe.ts --summarize ./chatgpt-probe.ndjson
 */

import http from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildWebhookHeaders } from "../src/events/standard-webhooks.js";
import { decodeWebhookSecret } from "../src/mcp-client-manager/events-ext.js";
import {
  callbackUrlShape,
  summarizeProbeObservations,
  type ProbeObservation,
} from "../src/events/probe-observations.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i]!;
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1] ?? "true");
}

if (args.has("summarize")) {
  const observations = readFileSync(args.get("summarize")!, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProbeObservation);
  process.stdout.write(`${JSON.stringify(summarizeProbeObservations(observations), null, 2)}\n`);
  process.exit(0);
}

const port = Number(args.get("port") ?? 8787);
const out = args.get("out") ?? "./chatgpt-probe.ndjson";
const grantMs = Number(args.get("grant-ms") ?? 10 * 60 * 1000);
const probeToken = process.env.PROBE_TOKEN;
if (!probeToken || probeToken.length < 16) {
  process.stderr.write("PROBE_TOKEN (>= 16 chars) is required for /probe/deliver\n");
  process.exit(1);
}

function record(observation: ProbeObservation): void {
  appendFileSync(out, `${JSON.stringify(observation)}\n`);
  process.stderr.write(`[probe] ${observation.kind} ${JSON.stringify(observation)}\n`);
}

interface LiveSubscription {
  id: string;
  url: string;
  secret: string;
  refreshBefore: number;
}
const subscriptions = new Map<string, LiveSubscription>();
let lastEventId: string | undefined;

async function post(
  subscription: LiveSubscription,
  webhookId: string,
  body: string,
  options: { secret?: string; timestampOffsetSeconds?: number } = {}
): Promise<{ status: number | "network_error"; text?: string }> {
  const headers = await buildWebhookHeaders({
    secrets: [options.secret ?? subscription.secret],
    webhookId,
    timestampSeconds: Math.floor(Date.now() / 1000) + (options.timestampOffsetSeconds ?? 0),
    body,
    subscriptionId: subscription.id,
  });
  try {
    const response = await fetch(subscription.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, text: await response.text() };
  } catch {
    return { status: "network_error" };
  }
}

const loose = z.looseObject({});

function buildServer(ctx: { requestInfo?: Request }) {
  const protocolVersion = ctx.requestInfo?.headers.get("mcp-protocol-version") ?? undefined;
  const server = new Server(
    { name: "mcpjam-chatgpt-events-probe", version: "1.0.0" },
    { capabilities: { tools: {}, events: {} } as never }
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "probe_status",
        description: "Report how many probe subscriptions are live.",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async () => ({
    content: [{ type: "text" as const, text: `${subscriptions.size} live subscription(s)` }],
  }));
  server.setRequestHandler("events/list", { params: loose }, async () => {
    record({ kind: "list", at: new Date().toISOString(), ...(protocolVersion ? { protocolVersion } : {}) });
    return {
      events: [
        {
          name: "probe.ping",
          description: "A probe event MCPJam sends on demand.",
          delivery: ["webhook"],
          inputSchema: {
            type: "object",
            properties: { topic: { type: "string", description: "Any label." } },
            additionalProperties: false,
          },
          payloadSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        },
      ],
    };
  });
  server.setRequestHandler("events/subscribe", { params: loose }, async (params: any) => {
    const secret = params.delivery?.secret;
    const secretBytes = typeof secret === "string" ? decodeWebhookSecret(secret)?.length ?? null : null;
    const url = String(params.delivery?.url ?? "");
    const id = `sub_${Buffer.from(url).toString("base64url").slice(-16)}`;
    const existing = subscriptions.get(id);
    const now = Date.now();
    record({
      kind: "subscribe",
      at: new Date(now).toISOString(),
      ...(protocolVersion ? { protocolVersion } : {}),
      ttlMs: "ttlMs" in params ? params.ttlMs : "omitted",
      secretBytes,
      cursorSent: !("cursor" in params) ? "omitted" : params.cursor === null ? "null" : "value",
      callbackUrlShape: callbackUrlShape(url),
      isRefresh: existing !== undefined,
      ...(existing ? { leadMs: existing.refreshBefore - now } : {}),
    });
    if (typeof secret !== "string" || !decodeWebhookSecret(secret)) {
      const error = new Error("delivery.secret must be whsec_ + base64 of 24–64 bytes") as Error & { code: number };
      error.code = -32602;
      throw error;
    }
    const subscription: LiveSubscription = { id, url, secret, refreshBefore: now + grantMs };
    if (!existing) {
      const challenge = randomBytes(16).toString("hex");
      const answer = await post(
        subscription,
        `msg_verification_${randomBytes(6).toString("hex")}`,
        JSON.stringify({ type: "verification", challenge })
      );
      let echoMatched = false;
      try {
        echoMatched = JSON.parse(answer.text ?? "{}").challenge === challenge;
      } catch {
        echoMatched = false;
      }
      record({ kind: "delivery", at: new Date().toISOString(), variant: "verification", status: answer.status, echoMatched });
      if (!echoMatched) {
        const error = new Error("CallbackEndpointError") as Error & { code: number; data: unknown };
        error.code = -32015;
        error.data = { reason: "challenge_failed" };
        throw error;
      }
    }
    subscriptions.set(id, subscription);
    return { id, refreshBefore: new Date(subscription.refreshBefore).toISOString(), cursor: null, truncated: false };
  });
  server.setRequestHandler("events/unsubscribe", { params: loose }, async (params: any) => {
    const url = String(params.delivery?.url ?? "");
    record({ kind: "unsubscribe", at: new Date().toISOString(), callbackUrlShape: callbackUrlShape(url) });
    subscriptions.delete(`sub_${Buffer.from(url).toString("base64url").slice(-16)}`);
    return {};
  });
  return server;
}

const mcp = toNodeHandler(createMcpHandler((ctx) => buildServer(ctx as never)) as never) as (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => void;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://probe.local");
  if (url.pathname !== "/probe/deliver") {
    mcp(req, res);
    return;
  }
  if (req.headers["x-probe-token"] !== probeToken) {
    res.writeHead(401).end();
    return;
  }
  const variant = url.searchParams.get("variant") ?? "valid";
  const subscription = [...subscriptions.values()].at(-1);
  if (!subscription) {
    res.writeHead(409, { "content-type": "application/json" }).end('{"error":"no subscription"}');
    return;
  }
  const eventId = variant === "duplicate" && lastEventId ? lastEventId : `evt_${randomBytes(8).toString("hex")}`;
  lastEventId = eventId;
  const message = variant === "oversize" ? "x".repeat(262_145) : `probe ${variant} at ${new Date().toISOString()}`;
  const body = JSON.stringify({ eventId, name: "probe.ping", timestamp: new Date().toISOString(), data: { message }, cursor: null });
  const answer = await post(subscription, eventId, body, {
    ...(variant === "bad-signature" ? { secret: `whsec_${randomBytes(32).toString("base64")}` } : {}),
    ...(variant === "stale-timestamp" ? { timestampOffsetSeconds: -3600 } : {}),
  });
  record({
    kind: "delivery",
    at: new Date().toISOString(),
    variant: variant as "valid",
    status: answer.status,
  });
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ variant, status: answer.status }));
});

server.listen(port, () => {
  process.stderr.write(`[probe] listening on :${port}; observations → ${out}\n`);
});

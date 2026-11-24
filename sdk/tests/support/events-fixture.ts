/**
 * An MCP Events fixture server on the OFFICIAL `@modelcontextprotocol/server`
 * 2.0.0, served over a real socket.
 *
 * PIN: modelcontextprotocol/experimental-ext-triggers-events @ 28ec35e (`docs/design-sketch-proposal.md`).
 *
 * Why the official server rather than hand-rolled JSON-RPC (the skills
 * fixture's approach): the plan's proof point is that custom `events/*`
 * methods work END TO END through the official SDKs on both sides — the
 * server's three-argument `setRequestHandler`, `capabilities.events` in the
 * real handshake, related notifications on the request stream for push. A
 * hand-rolled fixture would prove only that our client parses our bytes.
 *
 * ## Conformant by default
 *   - top-level `capabilities.events: { listChanged: true }`;
 *   - `events/list`, `events/poll`, `events/subscribe`, `events/unsubscribe`,
 *     `events/stream`, per the pinned draft;
 *   - webhook callbacks MUST be `https` (the fixture rejects `http` with
 *     `-32602` unless `allowInsecureCallbacks` — the labelled, NON-conformant
 *     development mode, which never counts as a conformance pass);
 *   - receiver consent by the challenge handshake, sent synchronously INSIDE
 *     `events/subscribe` — the case contract C3 exists for;
 *   - deliveries signed per Standard Webhooks, `webhook-id` = `eventId`.
 *
 * ## Switchable faults (`misbehave`)
 * Every fault the plan's phase-1/phase-2 gates name: skip consent, bad
 * signature, wrong id, dropped response, conflicting id, event before the
 * subscribe response, `gap` and `terminated` envelopes.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { z } from "zod";
import { buildWebhookHeaders } from "../../src/events/standard-webhooks.js";
import { decodeWebhookSecret } from "../../src/mcp-client-manager/events-ext.js";
import { canonicalJson } from "../../src/contract/canonical.js";
import { createCatalogFixture } from "./events-catalog-fixture.js";

export * from "./events-fixture-contract.js";
import {
  BETA_ERRORS, EVENTS_FIXTURE_INFO, FIXTURE_ERRORS, FIXTURE_EVENT_TYPES, betaEventTypes,
  type EventsFixtureOptions, type EventsFixtureHandle, type EventsFixtureMisbehavior,
  type DeliveryRecord, type FixtureSubscription, type StoredEvent,
} from "./events-fixture-contract.js";

class JsonRpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

function matches(
  subscriptionArgs: Record<string, unknown>,
  data: Record<string, unknown>
): boolean {
  // The fixture's argument semantics: every argument is an equality filter
  // on the same-named payload field.
  return Object.entries(subscriptionArgs).every(
    ([key, value]) => data[key] === value
  );
}

/** The illustrative ranges the draft names (IANA special-purpose registries). */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!v4) return /^f[cd]|^fe80/i.test(host);
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function derivedId(principal: string, url: string, name: string, args: unknown) {
  return `sub_${createHash("sha256")
    .update(canonicalJson({ principal, url, name, arguments: args }))
    .digest("hex")
    .slice(0, 16)}`;
}

const looseParams = z.looseObject({});

export async function startEventsFixture(
  options: EventsFixtureOptions = {}
): Promise<EventsFixtureHandle> {
  const errors = options.beta ? BETA_ERRORS : FIXTURE_ERRORS;
  const now = options.now ?? (() => Date.now());
  const misbehavior: EventsFixtureMisbehavior = { ...options.misbehavior };
  const catalog = createCatalogFixture(() => !misbehavior.omitCatalogAcknowledgement);
  const deliveryFetch = options.deliveryFetch ?? fetch;
  const received: EventsFixtureHandle["received"] = [];
  const deliveries: DeliveryRecord[] = [];
  const subscriptions = new Map<string, FixtureSubscription>();
  const log: StoredEvent[] = [];
  let position = 0;
  let firstRetained = 1;
  const streams = new Map<
    string,
    {
      name: string;
      arguments: Record<string, unknown>;
      notify: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
      requestId: string | number;
    }
  >();
  const retain = options.retainEvents ?? 100;
  const minTtl = options.minTtlMs ?? 60_000;
  const maxTtl = options.maxTtlMs ?? 60 * 60 * 1000;

  const cursorFor = (value: number) => `c${value}`;
  const parseCursor = (cursor: unknown): number | null => {
    if (cursor === null || cursor === undefined) return null;
    if (typeof cursor !== "string" || !/^c\d+$/.test(cursor)) {
      throw new JsonRpcFailure(errors.InvalidParams, "Malformed cursor");
    }
    return Number(cursor.slice(1));
  };

  const principalOf = (requestInfo?: Request): string => {
    const header = requestInfo?.headers.get("authorization") ?? "";
    const token = header.replace(/^Bearer\s+/i, "");
    if (!options.acceptedTokens) return token || "anonymous";
    if (!options.acceptedTokens.includes(token)) return "";
    return token;
  };

  const eventType = (name: unknown) => {
    const type = FIXTURE_EVENT_TYPES.find((entry) => entry.name === name);
    if (!type) {
      throw new JsonRpcFailure(errors.NotFound, "NotFound", {
        kind: "event",
      });
    }
    return type;
  };

  const validateArguments = (
    type: (typeof FIXTURE_EVENT_TYPES)[number],
    args: unknown
  ): Record<string, unknown> => {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new JsonRpcFailure(errors.InvalidParams, "arguments must be an object");
    }
    const schema = type.inputSchema as {
      required?: readonly string[];
      properties: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    for (const required of schema.required ?? []) {
      if (typeof (args as Record<string, unknown>)[required] !== "string") {
        throw new JsonRpcFailure(
          errors.InvalidParams,
          `arguments.${required} is required`
        );
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(args)) {
        if (!(key in schema.properties)) {
          throw new JsonRpcFailure(
            errors.InvalidParams,
            `arguments.${key} is not allowed`
          );
        }
      }
    }
    return args as Record<string, unknown>;
  };

  const post = async (
    subscription: FixtureSubscription,
    kind: DeliveryRecord["kind"],
    webhookId: string,
    body: string
  ): Promise<{ record: DeliveryRecord; response?: Response; networkReason?: "tls_error" | "timeout" }> => {
    const timestampSeconds = Math.floor(now() / 1000) - (misbehavior.staleTimestamp ? 3600 : 0);
    const secrets = misbehavior.badSignature
      ? [`whsec_${randomBytes(32).toString("base64")}`]
      : subscription.secrets;
    const headers = await buildWebhookHeaders({
      secrets,
      webhookId,
      timestampSeconds,
      body,
      subscriptionId: subscription.id,
    });
    let response: Response | undefined;
    let networkReason: "tls_error" | "timeout" | undefined;
    let status: DeliveryRecord["status"];
    try {
      response = await deliveryFetch(subscription.url, {
        method: "POST",
        headers,
        body,
        // The draft: deliveries MUST NOT follow redirects.
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      status = response.status;
    } catch (error) {
      status = "network_error";
      const cause = error instanceof Error ? error.cause : undefined;
      const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
      if (typeof code === "string" && /CERT|TLS|SELF_SIGNED|VERIFY_LEAF/.test(code)) {
        networkReason = "tls_error";
      } else if (error instanceof Error && error.name === "TimeoutError") {
        networkReason = "timeout";
      }
    }
    const record: DeliveryRecord = {
      subscriptionId: subscription.id,
      url: subscription.url,
      webhookId,
      kind,
      status,
      body,
    };
    deliveries.push(record);
    return { record, response, networkReason };
  };

  const verify = async (subscription: FixtureSubscription): Promise<void> => {
    const challenge = randomBytes(16).toString("hex");
    const { record, response, networkReason } = await post(
      subscription,
      "verification",
      `msg_verification_${randomBytes(6).toString("hex")}`,
      JSON.stringify({ type: "verification", challenge })
    );
    if (record.status === "network_error") {
      throw new JsonRpcFailure(errors.CallbackEndpointError, "CallbackEndpointError", {
        reason: networkReason ?? "connection_refused",
      });
    }
    let echoed: unknown;
    try {
      echoed = ((await response!.json()) as { challenge?: unknown }).challenge;
    } catch {
      echoed = undefined;
    }
    if (record.status < 200 || record.status >= 300 || echoed !== challenge) {
      throw new JsonRpcFailure(errors.CallbackEndpointError, "CallbackEndpointError", {
        reason: "challenge_failed",
      });
    }
  };

  const deliverEvent = async (subscription: FixtureSubscription, event: StoredEvent) => {
    const body = JSON.stringify({
      eventId: event.eventId,
      name: event.name,
      timestamp: event.timestamp,
      data: event.data,
      cursor: cursorFor(event.position),
    });
    return post(subscription, "event", options.beta && !misbehavior.reuseEventIdAsWebhookId ? randomBytes(24).toString("hex") : event.eventId, body);
  };

  const buildServer = (ctx: { requestInfo?: Request }) => {
    const server = new Server(EVENTS_FIXTURE_INFO, {
      // `events` is not in the server SDK's capability type; it must still
      // reach the wire, which is the whole point of the capture seam.
      capabilities: options.beta
        ? { tools: {}, extensions: { "io.modelcontextprotocol/events": { listChanged: true } } }
        : { tools: {}, events: { listChanged: true } } as never,
    });
    const principal = principalOf(ctx.requestInfo);
    const record = (method: string, params: unknown) => {
      if (options.beta && method.startsWith("events/") && method !== "events/list") {
        const headers = ctx.requestInfo?.headers;
        const body = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }).parse(params);
        if (headers?.get("mcp-name") !== body.name || (body.arguments.document_id !== undefined &&
            headers.get("mcp-param-document") !== body.arguments.document_id)) {
          throw new JsonRpcFailure(-32020, "HeaderMismatch");
        }
      }
      received.push({ method, params, principal });
    };
    const guard = <T>(fn: () => Promise<T> | T) => async () => {
      try {
        const result = await fn();
        return options.beta ? { ...result, resultType: "complete" } : result;
      } catch (error) {
        if (error instanceof JsonRpcFailure) {
          const failure = new Error(error.message) as Error & {
            code: number;
            data?: unknown;
          };
          failure.code = error.code;
          if (error.data !== undefined) failure.data = error.data;
          throw failure;
        }
        throw error;
      }
    };

    server.setRequestHandler("tools/list", async () => ({
      tools: [
        {
          name: "reply_to_comment",
          description: "Reply to a document comment.",
          inputSchema: {
            type: "object" as const,
            properties: {
              comment_id: { type: "string" },
              text: { type: "string" },
            },
            required: ["comment_id", "text"],
          },
        },
      ],
    }));
    server.setRequestHandler("tools/call", async (request: any) => {
      record("tools/call", request.params);
      await options.onToolCall?.();
      return {
        content: [
          {
            type: "text" as const,
            text: `replied to ${String(request.params?.arguments?.comment_id)}`,
          },
        ],
      };
    });

    server.setRequestHandler("events/list", { params: looseParams }, (params) =>
      guard(() => {
        record("events/list", params);
        if (catalog.replacement) {
          return { resultType: "complete", events: [{ name: catalog.replacement, delivery: ["poll"] }] };
        }
        return { resultType: "complete", events: options.beta ? betaEventTypes() : FIXTURE_EVENT_TYPES };
      })()
    );

    server.setRequestHandler("events/poll", { params: looseParams }, (params: any) =>
      guard(() => {
        record("events/poll", params);
        const type = eventType(params.name);
        if (!(type.delivery as readonly string[]).includes("poll")) {
          throw new JsonRpcFailure(errors.Unsupported, "Unsupported", {
            feature: "deliveryMode",
            value: "poll",
          });
        }
        const args = validateArguments(type, params.arguments ?? {});
        const from = parseCursor(params.cursor);
        if (from === null) {
          return {
            events: [],
            cursor: cursorFor(position),
            truncated: false,
            hasMore: false,
            nextPollMs: options.nextPollMs ?? 1000,
          };
        }
        const truncated = from < firstRetained - 1;
        const start = truncated ? firstRetained - 1 : from;
        const maxEvents =
          typeof params.maxEvents === "number" ? params.maxEvents : 50;
        const pending = log.filter(
          (event) =>
            event.position > start &&
            event.name === type.name &&
            matches(args, event.data)
        );
        const page = pending.slice(0, maxEvents);
        const lastPosition =
          page.length === pending.length
            ? position
            : page[page.length - 1]!.position;
        return {
          events: page.map((event) => ({
            eventId: event.eventId,
            name: event.name,
            timestamp: event.timestamp,
            data: event.data,
          })),
          cursor: cursorFor(lastPosition),
          truncated,
          hasMore: page.length < pending.length,
          nextPollMs: options.nextPollMs ?? 1000,
        };
      })()
    );

    server.setRequestHandler("events/subscribe", { params: looseParams }, (params: any) =>
      guard(async () => {
        record("events/subscribe", params);
        if (!principal) {
          throw new JsonRpcFailure(errors.Forbidden, "Forbidden");
        }
        const type = eventType(params.name);
        if (!(type.delivery as readonly string[]).includes("webhook")) {
          throw new JsonRpcFailure(errors.Unsupported, "Unsupported", {
            feature: "deliveryMode",
            value: "webhook",
          });
        }
        const args = validateArguments(type, params.arguments ?? {});
        const delivery = params.delivery ?? {};
        const secret = delivery.secret;
        if (typeof secret !== "string" || !decodeWebhookSecret(secret)) {
          throw new JsonRpcFailure(
            errors.InvalidParams,
            misbehavior.echoSecretInError
              ? `delivery.secret ${String(secret)} is not a valid whsec_ value`
              : "delivery.secret must be whsec_ + base64 of 24–64 bytes"
          );
        }
        if (misbehavior.echoSecretInError) {
          throw new JsonRpcFailure(
            errors.InvalidParams,
            `refusing delivery.secret ${secret}`
          );
        }
        let url: URL;
        try {
          url = new URL(String(delivery.url));
        } catch {
          throw new JsonRpcFailure(errors.InvalidParams, "delivery.url is malformed");
        }
        if (url.protocol !== "https:" && !options.allowInsecureCallbacks) {
          throw new JsonRpcFailure(
            errors.InvalidParams,
            "delivery.url must be https"
          );
        }
        const allowedPrivate = options.allowPrivateHosts ?? ["127.0.0.1", "localhost"];
        if (isPrivateHost(url.hostname) && !allowedPrivate.includes(url.hostname)) {
          throw new JsonRpcFailure(
            errors.InvalidParams,
            "delivery.url resolves to a non-public address"
          );
        }
        const key = derivedId(principal, url.toString(), type.name, args);
        const existing = subscriptions.get(key);
        const ttlRequested: number | null | undefined = params.ttlMs;
        const refreshBefore =
          ttlRequested === null && options.allowNoExpiry
            ? null
            : now() +
              Math.min(
                maxTtl,
                Math.max(minTtl, typeof ttlRequested === "number" ? ttlRequested : maxTtl)
              );
        const subscription: FixtureSubscription = existing
          ? {
              ...existing,
              // Rotation: dual-sign with the previous secret for a grace
              // window (the draft's SHOULD).
              secrets: existing.secrets[0] === secret ? [secret] : [secret, existing.secrets[0]!],
              refreshBefore,
              active: true,
            }
          : {
              id: key,
              principal,
              url: url.toString(),
              name: type.name,
              arguments: args,
              secrets: [secret],
              refreshBefore,
              verified: false,
              active: true,
            };
        // A NEW subscription is kept only once consent succeeded: a refused
        // challenge must leave nothing behind (the draft's "MUST NOT begin
        // delivering" — and nothing to refresh later either).
        if (!subscription.verified && !misbehavior.skipConsent) {
          await verify(subscription);
        }
        subscription.verified = true;
        subscriptions.set(key, subscription);
        if (misbehavior.eventBeforeResponse) {
          const event = await appendEvent(type.name, {
            ...args,
            comment_id: `early_${position + 1}`,
            text: "arrived before the subscribe response",
          });
          await deliverEvent(subscription, event);
        }
        if ((misbehavior.dropSubscribeResponses ?? 0) > 0) {
          misbehavior.dropSubscribeResponses! -= 1;
          throw new Error("fixture: subscribe response dropped after commit");
        }
        const id = misbehavior.conflictingId
          ? `sub_conflict_${randomBytes(4).toString("hex")}`
          : misbehavior.wrongId
            ? "sub_wrong"
            : key;
        return {
          id,
          refreshBefore:
            refreshBefore === null ? null : new Date(refreshBefore).toISOString(),
          cursor: cursorFor(position),
          truncated: false,
          ...(existing
            ? {
                deliveryStatus: {
                  active: true,
                  lastDeliveryAt: null,
                  lastError: null,
                },
              }
            : {}),
        };
      })()
    );

    server.setRequestHandler("events/unsubscribe", { params: looseParams }, (params: any) =>
      guard(() => {
        record("events/unsubscribe", params);
        if (!principal) {
          throw new JsonRpcFailure(errors.Forbidden, "Forbidden");
        }
        const key = derivedId(
          principal,
          new URL(String(params.delivery?.url)).toString(),
          String(params.name),
          params.arguments ?? {}
        );
        if (misbehavior.unsubscribeNotFound || !subscriptions.has(key)) {
          throw new JsonRpcFailure(errors.NotFound, "NotFound", {
            kind: "subscription",
          });
        }
        subscriptions.delete(key);
        return {};
      })()
    );

    server.setRequestHandler("events/stream", { params: looseParams }, (params: any, ctx: any) =>
      guard(async () => {
        record("events/stream", params);
        const type = eventType(params.name);
        const args = validateArguments(type, params.arguments ?? {});
        const requestId = ctx.mcpReq.id as string | number;
        const meta = { "io.modelcontextprotocol/subscriptionId": requestId };
        const notify = (notification: {
          method: string;
          params: Record<string, unknown>;
        }) =>
          ctx.mcpReq.notify({
            method: notification.method,
            params: { ...notification.params, _meta: meta },
          });
        const streamKey = `${principal}:${String(requestId)}`;
        await notify({
          method: "notifications/events/active",
          params: { cursor: cursorFor(position), truncated: false, ...(options.beta ? { heartbeatMs: options.heartbeatMs ?? 30_000 } : {}) },
        });
        // Replay from a supplied cursor (reconnect-with-cursor).
        const from = parseCursor(params.cursor);
        if (from !== null) {
          for (const event of log) {
            if (event.position > from && event.name === type.name && matches(args, event.data)) {
              await notify({
                method: "notifications/events/event",
                params: {
                  eventId: event.eventId,
                  name: event.name,
                  timestamp: event.timestamp,
                  data: event.data,
                  cursor: cursorFor(event.position),
                },
              });
            }
          }
        }
        streams.set(streamKey, { name: type.name, arguments: args, notify, requestId });
        const heartbeat = setInterval(() => {
          void notify({
            method: "notifications/events/heartbeat",
            params: { cursor: cursorFor(position) },
          }).catch(() => undefined);
        }, options.heartbeatMs ?? 30_000);
        try {
          await new Promise<void>((resolve) => {
            const signal = ctx.mcpReq.signal as AbortSignal;
            if (signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          clearInterval(heartbeat);
          streams.delete(streamKey);
        }
        return { _meta: options.beta ? meta : {} };
      })()
    );

    return server;
  };

  const appendEvent = async (
    name: string,
    data: Record<string, unknown>,
    eventId?: string
  ): Promise<StoredEvent> => {
    position += 1;
    const event: StoredEvent = {
      position,
      eventId: eventId ?? `evt_${position}`,
      name,
      timestamp: new Date(now()).toISOString(),
      data,
    };
    log.push(event);
    while (log.length > retain) {
      log.shift();
      firstRetained = log[0]?.position ?? position + 1;
    }
    return event;
  };

  const handler = createMcpHandler((ctx) => buildServer(ctx as never));
  const nodeHandler = toNodeHandler({
    fetch(request, requestOptions) {
      if (options.beta && request.headers.get("mcp-method") === "subscriptions/listen") {
        return catalog.listen(request, (params) => received.push({
          method: "subscriptions/listen", params, principal: principalOf(request),
        }));
      }
      return handler.fetch(request, requestOptions);
    },
  }) as (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => void;
  // Open responses, so a test can make the SERVER drop a push stream without
  // sending its final result (the "stream ended without a result" gate).
  const openResponses = new Set<http.ServerResponse>();
  const httpServer = http.createServer((req, res) => {
    openResponses.add(res);
    res.on("close", () => openResponses.delete(res));
    nodeHandler(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    received,
    replaceCatalog: catalog.change,
    openCatalogStreams: catalog.openStreams,
    subscriptions: () => [...subscriptions.values()].map((entry) => ({ ...entry })),
    deliveries,
    misbehave: (patch) => Object.assign(misbehavior, patch),
    emit: async (name, data, emitOptions) => {
      const event = await appendEvent(name, data, emitOptions?.eventId);
      for (const subscription of subscriptions.values()) {
        if (
          subscription.active &&
          subscription.verified &&
          subscription.name === name &&
          matches(subscription.arguments, data)
        ) {
          await deliverEvent(subscription, event);
        }
      }
      for (const stream of streams.values()) {
        if (stream.name === name && matches(stream.arguments, data)) {
          await stream.notify({
            method: "notifications/events/event",
            params: {
              eventId: event.eventId,
              name: event.name,
              timestamp: event.timestamp,
              data: event.data,
              cursor: cursorFor(event.position),
            },
          });
        }
      }
      return event;
    },
    sendControl: async (subscriptionId, body) => {
      const subscription = [...subscriptions.values()].find(
        (entry) => entry.id === subscriptionId
      );
      if (!subscription) throw new Error(`No subscription ${subscriptionId}`);
      const { record } = await post(
        subscription,
        body.type,
        `msg_${body.type}_${randomBytes(6).toString("hex")}`,
        JSON.stringify(body)
      );
      if (body.type === "terminated") subscriptions.delete(subscription.id);
      return record;
    },
    truncateLog: (keepLast) => {
      while (log.length > keepLast) log.shift();
      firstRetained = log[0]?.position ?? position + 1;
    },
    openStreams: () => streams.size,
    dropStreams: () => {
      for (const res of openResponses) res.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}

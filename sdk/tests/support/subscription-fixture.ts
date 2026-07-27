/**
 * Dual-era subscription fixture for the Phase 7 §15.3 subscription MUSTs.
 *
 * The base dual-era fixture advertises no `listChanged` / `subscribe`
 * capability, so a `subscriptions/listen` stream against it would carry
 * nothing — the three subscription checks correctly skip there. This fixture
 * is the server that actually DOES the thing: it advertises every subscribable
 * capability and, whenever a listen stream opens, publishes real change events
 * onto the handler's bus so the stream carries the ack, then notifications
 * tagged with the subscription id, and (in the graceful variant) the
 * `subscriptions/listen` completion result.
 *
 * The conforming behavior is entirely upstream beta.4's (`createMcpHandler`
 * owns ack-first, filtering, id stamping and teardown) — the fixture only
 * supplies capabilities and publishes events. The MISBEHAVING variants
 * therefore cannot go through it: they hand-roll the listen response so a
 * check has something to catch. That is the point — a check that only ever
 * sees a conforming server is not evidence that it can fail.
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import { SUBSCRIPTION_ID_META_KEY } from "../../src/mcp-client-manager/subscription-coordinator.js";
import { z } from "zod";

export const SUBSCRIPTION_FIXTURE_SERVER_INFO = {
  name: "mcpjam-subscription-fixture",
  version: "1.0.0",
} as const;

/** The one resource the fixture publishes `resources/updated` for. */
export const SUBSCRIPTION_FIXTURE_RESOURCE_URI = "test://watched";

/** How long after a listen opens the fixture publishes its change events. */
export const SUBSCRIPTION_FIXTURE_EMIT_AFTER_MS = 25;

/** How long after a listen opens the graceful variant completes the stream. */
export const SUBSCRIPTION_FIXTURE_CLOSE_AFTER_MS = 120;

/** Every notification type the conforming fixture can publish. */
export const SUBSCRIPTION_FIXTURE_EVENTS = [
  "tools",
  "prompts",
  "resources",
  "resource-updated",
] as const;

export type SubscriptionFixtureEvent =
  (typeof SUBSCRIPTION_FIXTURE_EVENTS)[number];

export interface SubscriptionFixtureOptions {
  /** Change events to publish once a listen stream is open. */
  events?: readonly SubscriptionFixtureEvent[];
  emitAfterMs?: number;
  /**
   * Complete every open subscription this long after a stream opens (the
   * server-initiated graceful close). Omitted ⇒ the stream stays open, which
   * is the ordinary case and makes the graceful-close check skip.
   */
  gracefulCloseAfterMs?: number;
  /**
   * Capability overrides. The default advertises all four subscribable
   * capabilities; a narrower set is what makes the "unrequested type" probe
   * meaningful (the check asks only for what is advertised).
   */
  capabilities?: {
    toolsListChanged?: boolean;
    promptsListChanged?: boolean;
    resourcesListChanged?: boolean;
    resourcesSubscribe?: boolean;
  };
}

const ALL_CAPABILITIES = {
  toolsListChanged: true,
  promptsListChanged: true,
  resourcesListChanged: true,
  resourcesSubscribe: true,
} as const;

/**
 * Build a fresh subscription fixture server. `createMcpHandler` calls this per
 * request, so it must register the same surface every time.
 */
export function buildSubscriptionFixtureServer(
  options: SubscriptionFixtureOptions = {}
): McpServer {
  const capabilities = { ...ALL_CAPABILITIES, ...(options.capabilities ?? {}) };
  const server = new McpServer(SUBSCRIPTION_FIXTURE_SERVER_INFO, {
    capabilities: {
      tools: { listChanged: capabilities.toolsListChanged },
      prompts: { listChanged: capabilities.promptsListChanged },
      resources: {
        listChanged: capabilities.resourcesListChanged,
        subscribe: capabilities.resourcesSubscribe,
      },
    },
  });

  server.registerTool(
    "echo",
    {
      description: "Echoes the provided message back as text.",
      inputSchema: { message: z.string() },
    },
    async (args) => ({
      content: [{ type: "text" as const, text: String(args.message) }],
    })
  );

  server.registerResource(
    "watched",
    SUBSCRIPTION_FIXTURE_RESOURCE_URI,
    {
      description: "A resource the fixture publishes updates for.",
      mimeType: "text/plain",
    },
    async () => ({
      contents: [
        {
          uri: SUBSCRIPTION_FIXTURE_RESOURCE_URI,
          mimeType: "text/plain",
          text: "watched",
        },
      ],
    })
  );

  server.registerPrompt(
    "welcome",
    { description: "A trivial welcome prompt." },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: "welcome" },
        },
      ],
    })
  );

  return server;
}

/** Whether this request is a `subscriptions/listen` (the header mirrors the body). */
function isListenRequest(request: Request): boolean {
  return request.headers.get("mcp-method") === "subscriptions/listen";
}

/**
 * A conforming dual-era handler that publishes change events whenever a
 * subscription opens. `close()` completes any still-open stream, so the
 * graceful variant is just this handler closing itself on a timer.
 */
export function createSubscriptionFixtureHandler(
  options: SubscriptionFixtureOptions = {}
): McpHttpHandler {
  const events = options.events ?? SUBSCRIPTION_FIXTURE_EVENTS;
  const emitAfterMs = options.emitAfterMs ?? SUBSCRIPTION_FIXTURE_EMIT_AFTER_MS;
  // Keepalive comment frames are noise for a bounded observation window and
  // would keep the probe's idle timer alive; the checks assert message frames.
  const handler = createMcpHandler(
    () => buildSubscriptionFixtureServer(options),
    { keepAliveMs: 0 }
  );
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const later = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  };

  const publish = () => {
    for (const event of events) {
      switch (event) {
        case "tools":
          handler.notify.toolsChanged();
          break;
        case "prompts":
          handler.notify.promptsChanged();
          break;
        case "resources":
          handler.notify.resourcesChanged();
          break;
        case "resource-updated":
          handler.notify.resourceUpdated(SUBSCRIPTION_FIXTURE_RESOURCE_URI);
          break;
      }
    }
  };

  return {
    ...handler,
    fetch: async (request, requestOptions) => {
      const listening = isListenRequest(request);
      const response = await handler.fetch(request, requestOptions);
      if (listening) {
        later(emitAfterMs, publish);
        if (options.gracefulCloseAfterMs !== undefined) {
          later(options.gracefulCloseAfterMs, () => {
            void handler.close();
          });
        }
      }
      return response;
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await handler.close();
    },
  };
}

/** The ways a listen stream can violate one of the three subscription MUSTs. */
export type MisbehavingSubscriptionMode =
  /** Emits a notification BEFORE the acknowledgement. */
  | "notification-before-ack"
  /** Emits a notification type the subscription never requested. */
  | "unrequested-type"
  /** Emits messages without the subscription-id tag. */
  | "untagged"
  /** Ends the stream without the completion result. */
  | "close-without-completion";

interface WireMessage {
  jsonrpc: "2.0";
  method?: string;
  id?: number | string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

function sseFrame(message: WireMessage): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

function tagged(
  message: WireMessage,
  subscriptionId: number | string,
  tag: boolean
): WireMessage {
  if (!tag) return message;
  return {
    ...message,
    params: {
      ...(message.params ?? {}),
      _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId },
    },
  };
}

/**
 * A handler whose `subscriptions/listen` deliberately breaks one MUST while
 * everything else is served by the real dual-era handler. The listen response
 * is hand-rolled: upstream's listen router is conforming by construction, so
 * a non-conforming stream cannot be produced through it.
 */
export function createMisbehavingSubscriptionHandler(
  mode: MisbehavingSubscriptionMode,
  options: SubscriptionFixtureOptions = {}
): McpHttpHandler {
  const handler = createSubscriptionFixtureHandler(options);

  const listenResponse = async (request: Request): Promise<Response> => {
    const body = (await request.json()) as {
      id: number | string;
      params?: { notifications?: Record<string, unknown> };
    };
    const subscriptionId = body.id;
    const requested = body.params?.notifications ?? {};
    const tag = mode !== "untagged";

    const ack: WireMessage = tagged(
      {
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: { notifications: requested },
      },
      subscriptionId,
      tag
    );
    // `resources/updated` for a URI nobody asked for: outside the requested
    // filter whatever the requested filter happens to be.
    const notification: WireMessage = tagged(
      mode === "unrequested-type"
        ? {
            jsonrpc: "2.0",
            method: "notifications/resources/updated",
            params: { uri: "test://never-requested" },
          }
        : { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      subscriptionId,
      tag
    );

    const frames =
      mode === "notification-before-ack"
        ? [notification, ack]
        : [ack, notification];

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(sseFrame(frame)));
        }
        if (mode === "close-without-completion") {
          controller.close();
          return;
        }
        // Every other mode leaves the stream open, exactly like a real
        // subscription, so only the intended MUST is under test.
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  };

  return {
    ...handler,
    fetch: async (request, requestOptions) =>
      isListenRequest(request)
        ? await listenResponse(request)
        : await handler.fetch(request, requestOptions),
  };
}

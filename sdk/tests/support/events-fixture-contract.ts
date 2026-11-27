export const EVENTS_FIXTURE_INFO = {
  name: "mcpjam-events-fixture",
  version: "1.0.0",
} as const;

/** The draft's error codes, as the fixture answers them. */
export const FIXTURE_ERRORS = {
  InvalidParams: -32602,
  NotFound: -32011,
  Forbidden: -32012,
  ResourceExhausted: -32013,
  Unsupported: -32014,
  CallbackEndpointError: -32015,
} as const;

export const FIXTURE_EVENT_TYPES = [
  {
    name: "comment.created",
    description: "A new review comment was added to the specified document.",
    delivery: ["webhook", "poll", "push"],
    inputSchema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "ID of the document to monitor for new comments.",
        },
      },
      required: ["document_id"],
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: {
        document_id: { type: "string" },
        comment_id: { type: "string" },
        text: { type: "string" },
      },
      required: ["document_id", "comment_id", "text"],
    },
  },
  {
    name: "build.failed",
    description: "A CI build failed.",
    delivery: ["poll"],
    inputSchema: {
      type: "object",
      properties: { branch: { type: "string" } },
    },
    payloadSchema: {
      type: "object",
      properties: { branch: { type: "string" }, buildId: { type: "string" } },
    },
  },
] as const;

export interface EventsFixtureMisbehavior {
  omitCatalogAcknowledgement?: boolean;
  /** Activate delivery without the verification handshake. */
  skipConsent?: boolean;
  /** Sign deliveries with a secret the receiver never saw. */
  badSignature?: boolean;
  /** Return a subscription id that does not match the derived one. */
  wrongId?: boolean;
  reuseEventIdAsWebhookId?: boolean;
  /** Return a DIFFERENT id on every subscribe (a server that re-keys). */
  conflictingId?: boolean;
  /**
   * Create/refresh the subscription, then fail the response — the client
   * cannot tell whether it landed ("response lost"). Counts down per call.
   */
  dropSubscribeResponses?: number;
  /** POST one event to the callback BEFORE answering subscribe. */
  eventBeforeResponse?: boolean;
  /** Put a stale `webhook-timestamp` on deliveries. */
  staleTimestamp?: boolean;
  /** Echo the secret back in an error message (redaction test). */
  echoSecretInError?: boolean;
  /** Answer `events/unsubscribe` NotFound even for live subscriptions. */
  unsubscribeNotFound?: boolean;
}

export interface EventsFixtureOptions {
  beta?: boolean;
  onToolCall?: () => Promise<void>;
  /** Labelled non-conformant: accept `http://` callback URLs. */
  allowInsecureCallbacks?: boolean;
  /**
   * Private destinations explicitly configured as allowed (the draft's
   * "unless explicitly configured"). Default: loopback only, which is where
   * every test receiver lives. Any other private address is refused.
   */
  allowPrivateHosts?: string[];
  /** `fetch` used for webhook deliveries (e.g. one trusting a test CA). */
  deliveryFetch?: typeof fetch;
  /** Bearer tokens accepted as principals. Absent ⇒ "anonymous" principal. */
  acceptedTokens?: string[];
  /** Server-side minimum grant (clamp-up floor). Default 60 s. */
  minTtlMs?: number;
  /** Server-side maximum grant. Default 1 h. */
  maxTtlMs?: number;
  /** Grant `refreshBefore: null` when `ttlMs: null` is requested. */
  allowNoExpiry?: boolean;
  /** Events kept per type for poll/replay. Default 100. */
  retainEvents?: number;
  /** `nextPollMs` answered on poll. Default 1000. */
  nextPollMs?: number;
  /** Heartbeat interval on `events/stream`, ms. Default 30 s. */
  heartbeatMs?: number;
  now?: () => number;
  misbehavior?: EventsFixtureMisbehavior;
}

export interface FixtureSubscription {
  id: string;
  principal: string;
  url: string;
  name: string;
  arguments: Record<string, unknown>;
  secrets: string[];
  refreshBefore: number | null;
  verified: boolean;
  active: boolean;
}

export interface DeliveryRecord {
  subscriptionId: string;
  url: string;
  webhookId: string;
  kind: "event" | "verification" | "gap" | "terminated";
  status: number | "network_error";
  body: string;
}

export interface StoredEvent {
  position: number;
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface EventsFixtureHandle {
  url: string;
  /** Every JSON-RPC request the fixture received (params included). */
  received: Array<{ method: string; params?: unknown; principal: string }>;
  replaceCatalog: (name: string, matchingSubscription?: boolean) => void;
  openCatalogStreams: () => number;
  subscriptions: () => FixtureSubscription[];
  deliveries: DeliveryRecord[];
  misbehave: (patch: EventsFixtureMisbehavior) => void;
  /**
   * Emit an event: appended to the poll log, POSTed to every matching live
   * webhook subscription, and notified on every matching push stream.
   */
  emit: (
    name: string,
    data: Record<string, unknown>,
    options?: { eventId?: string }
  ) => Promise<StoredEvent>;
  /** POST a control envelope to a subscription's callback. */
  sendControl: (
    subscriptionId: string,
    body:
      | { type: "gap"; cursor: string | null }
      | {
          type: "terminated";
          error: { code: number; message: string; data?: unknown };
        }
  ) => Promise<DeliveryRecord>;
  /** Drop the oldest events so older cursors become stale (truncated). */
  truncateLog: (keepLast: number) => void;
  /** Open push streams, by request id. */
  openStreams: () => number;
  /** Destroy every open HTTP response — a server dropping its streams. */
  dropStreams: () => void;
  close: () => Promise<void>;
}

export const BETA_ERRORS = {
  InvalidParams: -32602,
  NotFound: -32023,
  Forbidden: -32024,
  ResourceExhausted: -32025,
  Unsupported: -32026,
  CallbackEndpointError: -32027,
} as const;

export function betaEventTypes() {
  return FIXTURE_EVENT_TYPES.map((event) =>
    event.name === "comment.created"
      ? {
          ...event,
          inputSchema: {
            ...event.inputSchema,
            properties: {
              document_id: { type: "string", "x-mcp-header": "Document" },
            },
          },
        }
      : event
  );
}

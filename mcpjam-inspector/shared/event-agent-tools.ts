/**
 * MCPJam's agent tools for MCP Events: the model subscribes from the
 * conversation, without a click.
 *
 * Real ChatGPT does this (observed with the Vercel connector):
 * the host gives the model `<connector>_list_event_types` and
 * `<connector>_subscribe_to_events`, validates the subscription's `params`
 * against the event's `inputSchema` BEFORE calling the server, creates an
 * event-triggered task in the current thread, and shows no approval card.
 * The model can pause or delete it later. The Events Beta leaves who triggers
 * a subscription to the host ("The client SDK chooses the mode and runs the
 * loop").
 *
 * The MCPJam client offers the same capabilities under fixed MCPJam names,
 * with a `server` argument instead of one tool set per connector. The tools
 * are client-fulfilled: the server advertises them with no `execute`, and the
 * Playground runs each call through the same code path as "Connect event",
 * so an agent's subscription is the same object a user's is.
 *
 * This module is PURE (types and plain data only), so the server builds the
 * definitions and the browser parses the calls from one source.
 */

export const EVENT_AGENT_TOOL_NAMES = {
  listEventTypes: "mcpjam_list_event_types",
  subscribe: "mcpjam_subscribe_to_event",
  listSubscriptions: "mcpjam_list_event_subscriptions",
  pause: "mcpjam_pause_event_subscription",
  resume: "mcpjam_resume_event_subscription",
  delete: "mcpjam_delete_event_subscription",
} as const;

export type EventAgentToolName =
  (typeof EVENT_AGENT_TOOL_NAMES)[keyof typeof EVENT_AGENT_TOOL_NAMES];

const TOOL_NAME_SET: ReadonlySet<string> = new Set(
  Object.values(EVENT_AGENT_TOOL_NAMES),
);

/**
 * Exact names, never a prefix: a server tool that happens to start with
 * `mcpjam_` stays an ordinary server tool.
 */
export function isEventAgentToolName(name: string): name is EventAgentToolName {
  return TOOL_NAME_SET.has(name);
}

// ---------------------------------------------------------------------------
// The per-turn snapshot the browser sends
// ---------------------------------------------------------------------------

/**
 * Which connected servers declare MCP Events (either declaration format; the
 * SDK's `resolveEventsSupport` decides), and their event names. Sent per chat
 * POST by a Playground that can run the calls; absent means no event tools.
 */
export interface EventToolsSnapshot {
  servers: Array<{ name: string; events: string[] }>;
}

export const EVENT_TOOLS_MAX_SERVERS = 32;
export const EVENT_TOOLS_MAX_EVENTS_PER_SERVER = 64;
export const EVENT_TOOLS_MAX_NAME_CHARS = 200;

export class EventToolsSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventToolsSnapshotError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > EVENT_TOOLS_MAX_NAME_CHARS
  ) {
    throw new EventToolsSnapshotError(
      `${label} must be a non-empty string of at most ${EVENT_TOOLS_MAX_NAME_CHARS} characters`,
    );
  }
  return value;
}

/**
 * Validate the client's snapshot. `undefined` for an absent or empty one, so
 * a turn without event servers advertises nothing.
 */
export function validateEventToolsSnapshot(
  input: unknown,
): EventToolsSnapshot | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input) || !Array.isArray(input.servers)) {
    throw new EventToolsSnapshotError("eventTools.servers must be an array");
  }
  if (input.servers.length > EVENT_TOOLS_MAX_SERVERS) {
    throw new EventToolsSnapshotError(
      `eventTools accepts at most ${EVENT_TOOLS_MAX_SERVERS} servers`,
    );
  }
  const seen = new Set<string>();
  const servers = input.servers.map((raw, index) => {
    if (!isRecord(raw) || !Array.isArray(raw.events)) {
      throw new EventToolsSnapshotError(
        `eventTools.servers[${index}] must be an object with an events array`,
      );
    }
    const name = boundedName(raw.name, `eventTools.servers[${index}].name`);
    if (seen.has(name)) {
      throw new EventToolsSnapshotError(
        `eventTools.servers[${index}].name '${name}' is duplicated`,
      );
    }
    seen.add(name);
    if (raw.events.length > EVENT_TOOLS_MAX_EVENTS_PER_SERVER) {
      throw new EventToolsSnapshotError(
        `eventTools.servers[${index}].events accepts at most ${EVENT_TOOLS_MAX_EVENTS_PER_SERVER} names`,
      );
    }
    const events = raw.events.map((event, eventIndex) =>
      boundedName(event, `eventTools.servers[${index}].events[${eventIndex}]`),
    );
    return { name, events };
  });
  return servers.length > 0 ? { servers } : undefined;
}

// ---------------------------------------------------------------------------
// Model-facing definitions
// ---------------------------------------------------------------------------

export interface EventAgentToolDefinition {
  name: EventAgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Server and event names are server-chosen text: keep them on one line. */
function inline(text: string): string {
  return JSON.stringify(text.replace(/\s+/g, " "));
}

const SUBSCRIPTION_ID = {
  type: "string",
  minLength: 1,
  description:
    "The subscription id from mcpjam_subscribe_to_event or mcpjam_list_event_subscriptions.",
};

function idOnlySchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: { subscriptionId: SUBSCRIPTION_ID },
    required: ["subscriptionId"],
    additionalProperties: false,
  };
}

export function buildEventAgentToolDefinitions(
  snapshot: EventToolsSnapshot,
): EventAgentToolDefinition[] {
  const serverNames = snapshot.servers.map((server) => server.name);
  const catalog = snapshot.servers
    .map(
      (server) =>
        `${inline(server.name)} (${server.events.map(inline).join(", ") || "no event types listed yet"})`,
    )
    .join("; ");
  const server = {
    type: "string",
    enum: serverNames,
    description: "The connected MCP server that publishes the event.",
  };
  return [
    {
      name: EVENT_AGENT_TOOL_NAMES.listEventTypes,
      description:
        "List the MCP event types a connected server publishes. Returns each event type's name, description, delivery modes and inputSchema (the arguments a subscription takes). " +
        `Servers with events: ${catalog}.`,
      inputSchema: {
        type: "object",
        properties: {
          server: {
            ...server,
            description: "Limit the list to one server. Omit to list every server's event types.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: EVENT_AGENT_TOOL_NAMES.subscribe,
      description:
        "Subscribe this conversation to an MCP event, so you are woken here when it happens. Use it when the user asks you to watch for something and act on it later (for example: \"if my flight is delayed, rebook me\"). " +
        "MCPJam checks `arguments` against the event's inputSchema before contacting the server and picks the delivery mode. When a matching event arrives, MCPJam starts a new turn in this conversation with the event data and your `instructions`. No confirmation step is needed when the user asked for this. " +
        `Servers with events: ${catalog}. Call mcpjam_list_event_types first if you don't know an event's arguments.`,
      inputSchema: {
        type: "object",
        properties: {
          server,
          event: {
            type: "string",
            minLength: 1,
            description: "The event type name, exactly as mcpjam_list_event_types returns it.",
          },
          arguments: {
            type: "object",
            description:
              "The subscription arguments. They must satisfy the event type's inputSchema, with its exact property names.",
          },
          instructions: {
            type: "string",
            minLength: 1,
            description:
              "Standing instructions for the turn each event starts, written from the user's request: what to check in the event data and what to do (for example: \"If the flight is cancelled or delayed by 3 hours or more, rebook the traveler on the next flight and tell them the new flight.\").",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            description: "A short name the user sees in the Events pane, such as \"Rebook MJ204 if delayed\".",
          },
        },
        required: ["server", "event", "arguments", "instructions", "title"],
        additionalProperties: false,
      },
    },
    {
      name: EVENT_AGENT_TOOL_NAMES.listSubscriptions,
      description:
        "List the event subscriptions connected to this Playground's agent, with each one's id, title, server, event, arguments, instructions and status (listening, paused, …).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: EVENT_AGENT_TOOL_NAMES.pause,
      description:
        "Pause an event subscription. Events that arrive while it is paused don't start a turn. It stays in the Events pane and can be resumed.",
      inputSchema: idOnlySchema(),
    },
    {
      name: EVENT_AGENT_TOOL_NAMES.resume,
      description:
        "Resume a paused event subscription. Only events that arrive after resuming start a turn.",
      inputSchema: idOnlySchema(),
    },
    {
      name: EVENT_AGENT_TOOL_NAMES.delete,
      description:
        "Stop an event subscription for this conversation and remove it from the Playground Events pane, the same as \"Disconnect from agent\". Its events no longer start turns here. The server subscription stays in the Events tab, where the user can remove it.",
      inputSchema: idOnlySchema(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Parsing a call
// ---------------------------------------------------------------------------

export type EventAgentCall =
  | { tool: "list_event_types"; server?: string }
  | {
      tool: "subscribe";
      server: string;
      event: string;
      arguments: Record<string, unknown>;
      instructions: string;
      title: string;
    }
  | { tool: "list_subscriptions" }
  | { tool: "pause" | "resume" | "delete"; subscriptionId: string };

export type ParsedEventAgentCall =
  | { ok: true; call: EventAgentCall }
  | { ok: false; error: string };

function text(
  input: Record<string, unknown>,
  key: string,
  problems: string[],
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    problems.push(`\`${key}\` must be a non-empty string`);
    return "";
  }
  return value.trim();
}

/**
 * Check a call's shape. Model output is not trusted to follow the schema, so
 * every problem comes back as a sentence the model can act on.
 */
export function parseEventAgentToolCall(
  name: EventAgentToolName,
  rawInput: unknown,
): ParsedEventAgentCall {
  const input = isRecord(rawInput) ? rawInput : rawInput === undefined ? {} : null;
  if (!input) {
    return { ok: false, error: "The tool input must be a JSON object." };
  }
  const problems: string[] = [];
  let call: EventAgentCall;
  switch (name) {
    case EVENT_AGENT_TOOL_NAMES.listEventTypes: {
      const server = input.server;
      if (server !== undefined && (typeof server !== "string" || !server.trim())) {
        problems.push("`server` must be a server name, or omitted");
      }
      call = {
        tool: "list_event_types",
        ...(typeof server === "string" && server.trim() ? { server: server.trim() } : {}),
      };
      break;
    }
    case EVENT_AGENT_TOOL_NAMES.subscribe: {
      const server = text(input, "server", problems);
      const event = text(input, "event", problems);
      const instructions = text(input, "instructions", problems);
      const title = text(input, "title", problems);
      const args = input.arguments === undefined ? {} : input.arguments;
      if (!isRecord(args)) {
        problems.push("`arguments` must be a JSON object");
      }
      call = {
        tool: "subscribe",
        server,
        event,
        arguments: isRecord(args) ? args : {},
        instructions,
        title: title.slice(0, 120),
      };
      break;
    }
    case EVENT_AGENT_TOOL_NAMES.listSubscriptions:
      call = { tool: "list_subscriptions" };
      break;
    case EVENT_AGENT_TOOL_NAMES.pause:
    case EVENT_AGENT_TOOL_NAMES.resume:
    case EVENT_AGENT_TOOL_NAMES.delete: {
      const subscriptionId = text(input, "subscriptionId", problems);
      call = {
        tool:
          name === EVENT_AGENT_TOOL_NAMES.pause
            ? "pause"
            : name === EVENT_AGENT_TOOL_NAMES.resume
              ? "resume"
              : "delete",
        subscriptionId,
      };
      break;
    }
  }
  return problems.length > 0
    ? { ok: false, error: `Fix the input and call ${name} again: ${problems.join("; ")}.` }
    : { ok: true, call };
}

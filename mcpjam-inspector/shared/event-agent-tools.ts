/**
 * MCPJam's agent tools for MCP Events: the model subscribes from the
 * conversation, without a click.
 *
 * Real ChatGPT does this, and these tools copy what its model was observed
 * calling on a custom connector (the MCPJam Flights demo):
 *
 *   - `<connector>_subscribe_to_events` with `{title, prompt, triggers:
 *     [{event, params}], default_timezone, run_in_current_thread}`, where
 *     `prompt` is the standing instructions the model wrote from the ask;
 *   - `<connector>_update_subscription` with `{jawbone_id, is_enabled,
 *     triggers, prompt}`: new triggers MOVE an existing watch (a new trip
 *     updated the watch instead of adding a second one), and `is_enabled:
 *     false` is how it pauses (there is no pause tool);
 *   - the host validated `params` against the event's `inputSchema` BEFORE
 *     contacting the server, and showed no approval card.
 *
 * The Events Beta leaves who triggers a subscription to the host ("The client
 * SDK chooses the mode and runs the loop").
 *
 * The MCPJam client keeps those semantics and field names under fixed MCPJam
 * tool names, with a `server` argument instead of one tool set per connector.
 * It drops `default_timezone` (no schedules here) and `run_in_current_thread`
 * (an event always runs in the conversation that subscribed). The tools are
 * client-fulfilled: the server advertises them with no `execute`, and the
 * Playground runs each call through the same code path as "Connect event", so
 * an agent's subscription is the same object a user's is.
 *
 * This module is PURE (types and plain data only), so the server builds the
 * definitions and the browser parses the calls from one source.
 */

import { needsApprovalFor } from "./tool-approval";

export const EVENT_AGENT_TOOL_NAMES = {
  listEventTypes: "mcpjam_list_event_types",
  subscribe: "mcpjam_subscribe_to_events",
  update: "mcpjam_update_event_subscription",
  listSubscriptions: "mcpjam_list_event_subscriptions",
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

/** The three tools that create a watch or change what future events make the agent do. */
const MUTATING: ReadonlySet<string> = new Set([
  EVENT_AGENT_TOOL_NAMES.subscribe,
  EVENT_AGENT_TOOL_NAMES.update,
  EVENT_AGENT_TOOL_NAMES.delete,
]);

/**
 * Whether a call waits for the user's approval. ChatGPT shows no approval card,
 * so by default none does; a user who turned on Require tool approval gets it
 * for the tools that change a watch. The list tools never ask.
 */
export function eventToolCallNeedsApproval(
  name: string,
  requireToolApproval: boolean,
): boolean {
  return MUTATING.has(name) && needsApprovalFor("setting", requireToolApproval);
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
    "The subscription_id from mcpjam_subscribe_to_events or mcpjam_list_event_subscriptions.",
};

const TITLE = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  description:
    'A short name the user sees in the Events pane, such as "Rebook MJ204 if delayed".',
};

const PROMPT = {
  type: "string",
  minLength: 1,
  description:
    'Standing instructions for the turn each event starts, written from the user\'s request: what to check in the event data and what to do (for example: "If the flight is cancelled or delayed by 3 hours or more, rebook the traveler on the next flight and tell them the new flight.").',
};

/** One trigger per subscription: a Playground connection pairs one event with its prompt. */
const TRIGGERS = {
  type: "array",
  minItems: 1,
  maxItems: 1,
  description:
    "The event to watch, as one trigger. For a second event, create another subscription.",
  items: {
    type: "object",
    properties: {
      event: {
        type: "string",
        minLength: 1,
        description:
          "The event type name, exactly as mcpjam_list_event_types returns it.",
      },
      params: {
        type: "object",
        description:
          "The subscription arguments. They must satisfy the event type's inputSchema, with its exact property names.",
      },
    },
    required: ["event", "params"],
    additionalProperties: false,
  },
};

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
        "List the MCP event types a connected server publishes. Returns each event type's name, description, delivery modes and inputSchema (the params a trigger takes). " +
        `Servers with events: ${catalog}.`,
      inputSchema: {
        type: "object",
        properties: {
          server: {
            ...server,
            description:
              "Limit the list to one server. Omit to list every server's event types.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: EVENT_AGENT_TOOL_NAMES.subscribe,
      description:
        'Subscribe this conversation to an MCP event, so you are woken here when it happens. Use it when the user asks you to watch for something and act on it later (for example: "if my flight is delayed, rebook me"). ' +
        "MCPJam checks each trigger's params against the event's inputSchema before contacting the server and picks the delivery mode. When a matching event arrives, MCPJam starts a new turn in this conversation with the event and your `prompt`. Delivery has limits: events start turns only while this conversation is open in the Playground, and an event that arrives while you are in the middle of a turn is skipped. Tell the user this when you confirm the watch. " +
        "If a subscription for the same purpose already exists (for example, the user changed trips), change it with mcpjam_update_event_subscription instead of creating a second one. " +
        `Servers with events: ${catalog}. Call mcpjam_list_event_types first if you don't know an event's params.`,
      inputSchema: {
        type: "object",
        properties: {
          server,
          title: TITLE,
          prompt: PROMPT,
          triggers: TRIGGERS,
        },
        required: ["server", "title", "prompt", "triggers"],
        additionalProperties: false,
      },
    },
    {
      name: EVENT_AGENT_TOOL_NAMES.update,
      description:
        "Change an existing event subscription. `is_enabled: false` pauses it (events that arrive while paused don't start a turn) and `is_enabled: true` resumes it. New `triggers` move it to another event or other params, such as a new trip, keeping its id. `prompt` and `title` replace the saved ones. Send only the fields that change.",
      inputSchema: {
        type: "object",
        properties: {
          subscription_id: SUBSCRIPTION_ID,
          is_enabled: {
            type: "boolean",
            description: "false pauses the subscription, true resumes it.",
          },
          title: TITLE,
          prompt: PROMPT,
          triggers: TRIGGERS,
        },
        required: ["subscription_id"],
        additionalProperties: false,
      },
    },
    {
      name: EVENT_AGENT_TOOL_NAMES.listSubscriptions,
      description:
        "List the event subscriptions connected to this Playground's agent, with each one's subscription_id, title, server, triggers, prompt, is_enabled and status (listening, paused, …).",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: EVENT_AGENT_TOOL_NAMES.delete,
      description:
        'Stop an event subscription for this conversation and remove it from the Playground Events pane, the same as "Disconnect from agent". Its events no longer start turns here. The server subscription stays in the Events tab, where the user can remove it.',
      inputSchema: {
        type: "object",
        properties: { subscription_id: SUBSCRIPTION_ID },
        required: ["subscription_id"],
        additionalProperties: false,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Parsing a call
// ---------------------------------------------------------------------------

export interface EventAgentTrigger {
  event: string;
  params: Record<string, unknown>;
}

export type EventAgentCall =
  | { tool: "list_event_types"; server?: string }
  | {
      tool: "subscribe";
      server: string;
      title: string;
      prompt: string;
      trigger: EventAgentTrigger;
    }
  | {
      tool: "update";
      subscriptionId: string;
      isEnabled?: boolean;
      title?: string;
      prompt?: string;
      trigger?: EventAgentTrigger;
    }
  | { tool: "list_subscriptions" }
  | { tool: "delete"; subscriptionId: string };

export type ParsedEventAgentCall =
  { ok: true; call: EventAgentCall } | { ok: false; error: string };

function text(
  input: Record<string, unknown>,
  key: string,
  problems: string[],
  optional = false,
): string | undefined {
  const value = input[key];
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    problems.push(`\`${key}\` must be a non-empty string`);
    return undefined;
  }
  return value.trim();
}

function trigger(
  input: Record<string, unknown>,
  problems: string[],
  optional = false,
): EventAgentTrigger | undefined {
  const value = input.triggers;
  if (optional && value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(
      "`triggers` must be an array with one {event, params} trigger",
    );
    return undefined;
  }
  if (value.length > 1) {
    problems.push(
      "`triggers` takes one trigger per subscription; create another subscription for a second event",
    );
    return undefined;
  }
  const [raw] = value;
  if (!isRecord(raw)) {
    problems.push("`triggers[0]` must be an object with `event` and `params`");
    return undefined;
  }
  const event = text(raw, "event", problems);
  const params = raw.params === undefined ? {} : raw.params;
  if (!isRecord(params)) {
    problems.push("`triggers[0].params` must be a JSON object");
    return undefined;
  }
  return event === undefined ? undefined : { event, params };
}

/**
 * Check a call's shape. Model output is not trusted to follow the schema, so
 * every problem comes back as a sentence the model can act on.
 */
export function parseEventAgentToolCall(
  name: EventAgentToolName,
  rawInput: unknown,
): ParsedEventAgentCall {
  const input = isRecord(rawInput)
    ? rawInput
    : rawInput === undefined
      ? {}
      : null;
  if (!input) {
    return { ok: false, error: "The tool input must be a JSON object." };
  }
  const problems: string[] = [];
  let call: EventAgentCall | undefined;
  switch (name) {
    case EVENT_AGENT_TOOL_NAMES.listEventTypes: {
      const server = text(input, "server", problems, true);
      call = { tool: "list_event_types", ...(server ? { server } : {}) };
      break;
    }
    case EVENT_AGENT_TOOL_NAMES.subscribe: {
      const server = text(input, "server", problems);
      const title = text(input, "title", problems);
      const prompt = text(input, "prompt", problems);
      const parsed = trigger(input, problems);
      if (server && title && prompt && parsed) {
        call = {
          tool: "subscribe",
          server,
          title: title.slice(0, 120),
          prompt,
          trigger: parsed,
        };
      }
      break;
    }
    case EVENT_AGENT_TOOL_NAMES.update: {
      const subscriptionId = text(input, "subscription_id", problems);
      const title = text(input, "title", problems, true);
      const prompt = text(input, "prompt", problems, true);
      const parsed = trigger(input, problems, true);
      const isEnabled = input.is_enabled;
      if (isEnabled !== undefined && typeof isEnabled !== "boolean") {
        problems.push("`is_enabled` must be true or false");
      }
      if (
        isEnabled === undefined &&
        input.title === undefined &&
        input.prompt === undefined &&
        input.triggers === undefined
      ) {
        problems.push(
          "send at least one of `is_enabled`, `title`, `prompt` or `triggers`",
        );
      }
      if (subscriptionId) {
        call = {
          tool: "update",
          subscriptionId,
          ...(typeof isEnabled === "boolean" ? { isEnabled } : {}),
          ...(title ? { title: title.slice(0, 120) } : {}),
          ...(prompt ? { prompt } : {}),
          ...(parsed ? { trigger: parsed } : {}),
        };
      }
      break;
    }
    case EVENT_AGENT_TOOL_NAMES.listSubscriptions:
      call = { tool: "list_subscriptions" };
      break;
    case EVENT_AGENT_TOOL_NAMES.delete: {
      const subscriptionId = text(input, "subscription_id", problems);
      if (subscriptionId) call = { tool: "delete", subscriptionId };
      break;
    }
  }
  return problems.length > 0 || !call
    ? {
        ok: false,
        error: `Fix the input and call ${name} again: ${problems.join("; ")}.`,
      }
    : { ok: true, call };
}

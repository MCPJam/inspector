/**
 * The Playground's half of the MCP Events agent tools
 * (`shared/event-agent-tools.ts`): it runs each client-fulfilled call against
 * the Playground events runtime, so a subscription the agent creates goes
 * through `add`, the same path as "Connect event", and is the same object: it
 * shows in the Events pane and the Events tab, and wakes the agent in this
 * conversation through the existing dispatcher.
 *
 * The host, not the model, picks the delivery mode, exactly as Connect event
 * defaults it (the first mode the runtime, the event type and the client all
 * accept). The one difference: a LOCAL webhook needs the user's consent for its
 * plain-HTTP receiver, which a model cannot give, so the agent never picks it.
 */
import {
  describeNoSubscribableMode,
  subscribableModes,
} from "@mcpjam/sdk/browser";
import {
  EVENT_TOOLS_MAX_EVENTS_PER_SERVER,
  EVENT_TOOLS_MAX_NAME_CHARS,
  EVENT_TOOLS_MAX_SERVERS,
  parseEventAgentToolCall,
  type EventAgentCall,
  type EventAgentToolName,
  type EventToolsSnapshot,
} from "@/shared/event-agent-tools";
import type {
  EventDescriptorView,
  EventsDeliveryModeView,
} from "@/shared/events-api";
import { bindingStatus } from "./binding-status";
import { checkEventArguments } from "./event-arguments";
import type {
  PlaygroundEventBinding,
  usePlaygroundEvents,
} from "./PlaygroundEventsProvider";

type Runtime = NonNullable<ReturnType<typeof usePlaygroundEvents>>;
export type EventAgentRuntime = Pick<
  Runtime,
  | "hosted"
  | "host"
  | "servers"
  | "bindings"
  | "catalogs"
  | "feed"
  | "loadCatalog"
  | "add"
  | "edit"
  | "remove"
>;

/** The MCP `CallToolResult` shape the chat already renders for app tools. */
export interface EventAgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function success(payload: Record<string, unknown>): EventAgentToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function failure(
  message: string,
  details: Record<string, unknown> = {},
): EventAgentToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: message, ...details }) },
    ],
    isError: true,
  };
}

const connected = (runtime: EventAgentRuntime, server: string) =>
  runtime.servers[server]?.connectionStatus === "connected";

/**
 * The servers to offer tools for: connected, and their catalog says Events
 * are declared with at least one event type. `undefined` offers none.
 */
export function eventToolsSnapshot(
  runtime: EventAgentRuntime | null,
): EventToolsSnapshot | undefined {
  if (!runtime?.host || runtime.host.missing) return undefined;
  const servers = runtime.catalogs
    .filter(
      (entry) =>
        connected(runtime, entry.serverName) &&
        entry.serverName.length <= EVENT_TOOLS_MAX_NAME_CHARS &&
        entry.catalog?.support.declared === true &&
        entry.catalog.events.length > 0,
    )
    .slice(0, EVENT_TOOLS_MAX_SERVERS)
    .map((entry) => ({
      name: entry.serverName,
      events: (entry.catalog?.events ?? [])
        .map((event) => event.name)
        .filter((name) => name.length <= EVENT_TOOLS_MAX_NAME_CHARS)
        .slice(0, EVENT_TOOLS_MAX_EVENTS_PER_SERVER),
    }));
  return servers.length > 0 ? { servers } : undefined;
}

/** Key order must not make two equal argument objects look different. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function describe(runtime: EventAgentRuntime, binding: PlaygroundEventBinding) {
  return {
    id: binding.id,
    ...(binding.title ? { title: binding.title } : {}),
    server: binding.serverName,
    event: binding.eventName,
    ...(binding.subscription
      ? {
          arguments: binding.subscription.arguments,
          delivery: binding.subscription.mode,
        }
      : {}),
    instructions: binding.instructions,
    status: bindingStatus(binding, {
      connected: connected(runtime, binding.serverName),
      feedStatus: runtime.feed.status,
    }).toLowerCase(),
    createdBy: binding.createdBy ?? "user",
  };
}

function eventServers(runtime: EventAgentRuntime): string[] {
  return runtime.catalogs
    .filter(
      (entry) =>
        connected(runtime, entry.serverName) &&
        entry.catalog?.support.declared === true,
    )
    .map((entry) => entry.serverName);
}

function pickMode(
  runtime: EventAgentRuntime,
  event: EventDescriptorView,
): { mode: EventsDeliveryModeView } | { error: string } {
  const host = runtime.host;
  if (!host) return { error: "Client settings are still loading. Try again in a moment." };
  if (host.missing)
    return { error: "The selected client no longer exists, so nothing can subscribe as it." };
  const availability = subscribableModes({
    host: null,
    hostModes: host.modes,
    eventModes: event.delivery,
    runtime: runtime.hosted ? "hosted" : "local",
  });
  const mode = availability.modes.find(
    (candidate) => runtime.hosted || candidate !== "webhook",
  );
  if (mode) return { mode };
  return {
    error:
      describeNoSubscribableMode(availability, host.name) ??
      `${event.name} can only be delivered here by a local webhook, which needs the user's consent for its plain-HTTP receiver. Ask the user to connect it with "Connect event" in the Playground's Events pane.`,
  };
}

async function listEventTypes(runtime: EventAgentRuntime, server?: string) {
  const servers = server ? [server] : eventServers(runtime);
  if (server && !connected(runtime, server)) {
    return failure(
      `"${server}" isn't connected. Servers with events: ${eventServers(runtime).join(", ") || "none"}.`,
    );
  }
  const loaded = await Promise.all(servers.map(runtime.loadCatalog));
  return success({
    servers: loaded.map((entry) =>
      entry.error
        ? { server: entry.serverName, error: entry.error }
        : !entry.catalog?.support.declared
          ? { server: entry.serverName, error: "This server doesn't declare MCP Events." }
          : {
              server: entry.serverName,
              eventTypes: entry.catalog.events.map((event) => ({
                name: event.name,
                ...(event.description ? { description: event.description } : {}),
                delivery: event.delivery,
                inputSchema: event.inputSchema ?? { type: "object" },
              })),
            },
    ),
  });
}

async function subscribe(
  runtime: EventAgentRuntime,
  call: Extract<EventAgentCall, { tool: "subscribe" }>,
) {
  if (!connected(runtime, call.server)) {
    return failure(
      `"${call.server}" isn't connected. Servers with events: ${eventServers(runtime).join(", ") || "none"}.`,
    );
  }
  const server = await runtime.loadCatalog(call.server);
  if (server.error) return failure(`Couldn't load the event types of "${call.server}": ${server.error}`);
  if (!server.catalog?.support.declared)
    return failure(`"${call.server}" doesn't declare MCP Events.`);
  const event = server.catalog.events.find((entry) => entry.name === call.event);
  if (!event) {
    return failure(
      `"${call.server}" has no event type "${call.event}". Its event types: ${server.catalog.events.map((entry) => entry.name).join(", ") || "none"}.`,
    );
  }
  const check = checkEventArguments(event.inputSchema, call.arguments);
  if (check.valid === false) {
    return failure(
      `The arguments don't match the inputSchema of ${event.name}, so nothing was sent to the server. Fix them and call mcpjam_subscribe_to_event again.`,
      {
        issues: check.issues,
        ...(check.hint ? { hint: check.hint } : {}),
        inputSchema: event.inputSchema ?? { type: "object" },
      },
    );
  }
  const duplicate = runtime.bindings.find(
    (binding) =>
      binding.serverName === call.server &&
      binding.eventName === call.event &&
      binding.subscription &&
      canonical(binding.subscription.arguments) === canonical(call.arguments),
  );
  if (duplicate) {
    return failure(
      "This event is already connected with these arguments. Use mcpjam_list_event_subscriptions to see it, or resume it if it's paused.",
      { subscription: describe(runtime, duplicate) },
    );
  }
  const picked = pickMode(runtime, event);
  if ("error" in picked) return failure(picked.error);
  const binding = await runtime.add(
    server,
    event,
    { arguments: call.arguments, mode: picked.mode },
    call.instructions,
    { title: call.title, fromAgent: true },
  );
  return success({
    subscription: describe(runtime, binding),
    message: `Subscribed. When ${event.name} arrives, MCPJam starts a new turn in this conversation with the event data and your instructions.`,
  });
}

async function updateState(
  runtime: EventAgentRuntime,
  call: Extract<EventAgentCall, { tool: "pause" | "resume" | "delete" }>,
) {
  const binding = runtime.bindings.find((entry) => entry.id === call.subscriptionId);
  if (!binding) {
    return failure(
      `No event subscription has the id "${call.subscriptionId}". Call mcpjam_list_event_subscriptions for the current ids.`,
    );
  }
  if (call.tool === "delete") {
    runtime.remove(binding.id);
    return success({
      deleted: binding.id,
      message:
        "Its events no longer start turns here. The server subscription stays in the Events tab.",
    });
  }
  const enabled = call.tool === "resume";
  await runtime.edit(binding.id, { enabled });
  return success({ subscription: describe(runtime, { ...binding, enabled }) });
}

export async function runEventAgentTool(
  runtime: EventAgentRuntime | null,
  name: EventAgentToolName,
  input: unknown,
): Promise<EventAgentToolResult> {
  if (!runtime) {
    return failure(
      "MCP Events aren't available in this Playground right now. Ask the user to open the Events pane.",
    );
  }
  const parsed = parseEventAgentToolCall(name, input);
  if (!parsed.ok) return failure(parsed.error);
  const call = parsed.call;
  try {
    switch (call.tool) {
      case "list_event_types":
        return await listEventTypes(runtime, call.server);
      case "subscribe":
        return await subscribe(runtime, call);
      case "list_subscriptions":
        return success({
          subscriptions: runtime.bindings.map((binding) => describe(runtime, binding)),
        });
      case "pause":
      case "resume":
      case "delete":
        return await updateState(runtime, call);
    }
  } catch (error) {
    return failure(
      error instanceof Error ? error.message : "The events request failed. Try again.",
    );
  }
}

/** Calls already run, so a re-fired `onToolCall` never subscribes twice. */
const MAX_REMEMBERED_CALLS = 500;

export function createEventAgentToolExecutor(
  getRuntime: () => EventAgentRuntime | null,
) {
  const calls = new Map<string, Promise<EventAgentToolResult>>();
  return {
    snapshot: () => eventToolsSnapshot(getRuntime()),
    execute(
      name: EventAgentToolName,
      toolCallId: string,
      input: unknown,
    ): Promise<EventAgentToolResult> {
      const existing = calls.get(toolCallId);
      if (existing) return existing;
      const run = runEventAgentTool(getRuntime(), name, input);
      calls.set(toolCallId, run);
      if (calls.size > MAX_REMEMBERED_CALLS) {
        const oldest = calls.keys().next().value;
        if (oldest !== undefined) calls.delete(oldest);
      }
      return run;
    },
  };
}

export type EventAgentToolExecutor = ReturnType<
  typeof createEventAgentToolExecutor
>;

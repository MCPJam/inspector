/**
 * The Playground's half of the MCP Events agent tools
 * (`shared/event-agent-tools.ts`): it runs each client-fulfilled call against
 * the Playground events runtime, so a subscription the agent creates goes
 * through `add`, the same path as "Connect event", and is the same object: it
 * shows in the Events pane and the Events tab, and wakes the agent in this
 * conversation through the existing dispatcher. Pause, resume and edits use the
 * pane's own `edit`; moving a watch to new params (`retarget`) reaches the
 * registry through the same create code as `add`.
 *
 * The host, not the model, picks the delivery mode, exactly as Connect event
 * defaults it: the first allowed mode in `preferredDeliveryModes`' order. The
 * one difference: a LOCAL webhook needs the user's consent for its plain-HTTP
 * receiver, which a model cannot give, so the agent picks it only when an
 * `https` receiver is saved for the server, and then subscribes with it.
 */
import {
  describeNoSubscribableMode,
  subscribableModes,
} from "@mcpjam/sdk/browser";
import { preferredDeliveryModes } from "@/shared/client-events";
import {
  EVENT_TOOLS_MAX_EVENTS_PER_SERVER,
  EVENT_TOOLS_MAX_NAME_CHARS,
  EVENT_TOOLS_MAX_SERVERS,
  parseEventAgentToolCall,
  type EventAgentCall,
  type EventAgentToolName,
  type EventAgentTrigger,
  type EventToolsSnapshot,
} from "@/shared/event-agent-tools";
import type { EventDescriptorView } from "@/shared/events-api";
import { serverHasSignIn } from "@/components/connection/server-auth";
import { savedHttpsReceiver } from "@/components/events/use-callback-preference";
import type { SubscribeFormValue } from "@/components/events/use-subscribe-form";
import { bindingStatus } from "./binding-status";
import { useEventAgentBridge } from "./event-agent-bridge";
import { checkEventArguments } from "./event-arguments";
import type {
  PlaygroundEventBinding,
  ServerEventCatalog,
  usePlaygroundEvents,
} from "./PlaygroundEventsProvider";

type Runtime = NonNullable<ReturnType<typeof usePlaygroundEvents>>;
export type EventAgentRuntime = Pick<
  Runtime,
  | "hosted"
  | "host"
  | "projectId"
  | "servers"
  | "bindings"
  | "catalogs"
  | "feed"
  | "loadCatalog"
  | "add"
  | "retarget"
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

/** What one conversation may reach. */
export interface EventAgentChat {
  /** The servers selected for this conversation. Absent means every server. */
  selectedServers?: readonly string[];
  /** The conversation's agent scope; another scope's connections belong to another chat. */
  agentScope?: string;
}

/**
 * The runtime as one conversation sees it: only the servers selected for it,
 * and only its own connections. Another chat's connections stay out of reach
 * for listing, lookup and duplicate detection; the two chats can still share
 * the underlying server subscription.
 */
function forChat(
  runtime: EventAgentRuntime,
  chat: EventAgentChat,
): EventAgentRuntime {
  const selected = chat.selectedServers;
  const inChat = (name: string) =>
    selected === undefined || selected.includes(name);
  return {
    ...runtime,
    servers: Object.fromEntries(
      Object.entries(runtime.servers).filter(([name]) => inChat(name)),
    ),
    catalogs: runtime.catalogs.filter((entry) => inChat(entry.serverName)),
    bindings: runtime.bindings.filter(
      (binding) =>
        chat.agentScope !== undefined && binding.agentScope === chat.agentScope,
    ),
  };
}

/**
 * The servers to offer tools for: connected, and their catalog says Events
 * are declared with at least one event type. `undefined` offers none.
 */
export function eventToolsSnapshot(
  source: EventAgentRuntime | null,
  chat: EventAgentChat = {},
): EventToolsSnapshot | undefined {
  if (!source?.host || source.host.missing) return undefined;
  const runtime = forChat(source, chat);
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

/** A subscription in the tools' own field names (`subscription_id`, `prompt`, …). */
function describe(runtime: EventAgentRuntime, binding: PlaygroundEventBinding) {
  return {
    subscription_id: binding.id,
    ...(binding.title ? { title: binding.title } : {}),
    server: binding.serverName,
    triggers: [
      {
        event: binding.eventName,
        ...(binding.subscription
          ? { params: binding.subscription.arguments }
          : {}),
      },
    ],
    prompt: binding.instructions,
    is_enabled: binding.enabled,
    status: bindingStatus(binding, {
      connected: connected(runtime, binding.serverName),
      feedStatus: runtime.feed.status,
    }).toLowerCase(),
    ...(binding.subscription ? { delivery: binding.subscription.mode } : {}),
    created_by: binding.createdBy ?? "user",
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
  serverName: string,
  event: EventDescriptorView,
):
  | { delivery: Pick<SubscribeFormValue, "mode" | "receiver"> }
  | { error: string } {
  const host = runtime.host;
  if (!host)
    return {
      error: "Client settings are still loading. Try again in a moment.",
    };
  if (host.missing)
    return {
      error:
        "The selected client no longer exists, so nothing can subscribe as it.",
    };
  const availability = subscribableModes({
    host: null,
    hostModes: host.modes,
    eventModes: event.delivery,
    runtime: runtime.hosted ? "hosted" : "local",
  });
  const receiver = runtime.hosted
    ? undefined
    : savedHttpsReceiver(runtime.projectId, serverName);
  const mode = preferredDeliveryModes(availability.modes, {
    runtime: runtime.hosted ? "hosted" : "local",
    serverSignedIn: serverHasSignIn(runtime.servers[serverName]),
    httpsReceiver: receiver !== undefined,
  }).find(
    (candidate) =>
      runtime.hosted || candidate !== "webhook" || receiver !== undefined,
  );
  if (mode === "webhook" && receiver)
    return {
      delivery: { mode, receiver: { kind: "custom", baseUrl: receiver } },
    };
  if (mode) return { delivery: { mode } };
  return {
    error:
      describeNoSubscribableMode(availability, host.name, host.harnessName) ??
      `${event.name} can only be delivered here by a local webhook, which needs the user's consent for its plain-HTTP receiver. Ask the user to connect it with "Connect event" in the Playground's Events pane.`,
  };
}

async function listEventTypes(runtime: EventAgentRuntime, server?: string) {
  const servers = server ? [server] : eventServers(runtime);
  if (server && !connected(runtime, server)) {
    return failure(
      `"${server}" isn't connected or isn't selected for this chat. Servers with events: ${eventServers(runtime).join(", ") || "none"}.`,
    );
  }
  const loaded = await Promise.all(servers.map(runtime.loadCatalog));
  return success({
    servers: loaded.map((entry) =>
      entry.error
        ? { server: entry.serverName, error: entry.error }
        : !entry.catalog?.support.declared
          ? {
              server: entry.serverName,
              error: "This server doesn't declare MCP Events.",
            }
          : {
              server: entry.serverName,
              eventTypes: entry.catalog.events.map((event) => ({
                name: event.name,
                ...(event.description
                  ? { description: event.description }
                  : {}),
                delivery: event.delivery,
                inputSchema: event.inputSchema ?? { type: "object" },
              })),
            },
    ),
  });
}

/**
 * A trigger resolved against the server's live catalog and checked against
 * the event's inputSchema, or the error the model should see. Nothing has
 * been sent to the server yet.
 */
async function resolveTrigger(
  runtime: EventAgentRuntime,
  serverName: string,
  trigger: EventAgentTrigger,
  tool: string,
): Promise<
  | { server: ServerEventCatalog; event: EventDescriptorView }
  | { error: EventAgentToolResult }
> {
  if (!connected(runtime, serverName)) {
    return {
      error: failure(
        `"${serverName}" isn't connected or isn't selected for this chat. Servers with events: ${eventServers(runtime).join(", ") || "none"}.`,
      ),
    };
  }
  const server = await runtime.loadCatalog(serverName);
  if (server.error)
    return {
      error: failure(
        `Couldn't load the event types of "${serverName}". Try again, or ask the user to reconnect it.`,
        { reason: server.error },
      ),
    };
  if (!server.catalog?.support.declared)
    return { error: failure(`"${serverName}" doesn't declare MCP Events.`) };
  const event = server.catalog.events.find(
    (entry) => entry.name === trigger.event,
  );
  if (!event) {
    return {
      error: failure(
        `"${serverName}" has no event type "${trigger.event}". Its event types: ${server.catalog.events.map((entry) => entry.name).join(", ") || "none"}.`,
      ),
    };
  }
  const check = checkEventArguments(event.inputSchema, trigger.params);
  if (check.valid === false) {
    return {
      error: failure(
        `The arguments for ${event.name} don't match what it accepts, so nothing was sent to the server. Fix the arguments and call ${tool} again.`,
        {
          issues: check.issues,
          ...(check.hint ? { hint: check.hint } : {}),
          inputSchema: event.inputSchema ?? { type: "object" },
        },
      ),
    };
  }
  return { server, event };
}

const sameTrigger = (
  binding: PlaygroundEventBinding,
  serverName: string,
  trigger: EventAgentTrigger,
) =>
  binding.serverName === serverName &&
  binding.eventName === trigger.event &&
  !!binding.subscription &&
  canonical(binding.subscription.arguments) === canonical(trigger.params);

/** An edit the provider dropped, such as a newer change to the same watch. */
const notApplied = () =>
  failure(
    "The change wasn't applied because this subscription changed at the same time. List your event subscriptions and try again.",
  );

async function subscribe(
  runtime: EventAgentRuntime,
  call: Extract<EventAgentCall, { tool: "subscribe" }>,
  scope: string | undefined,
) {
  const resolved = await resolveTrigger(
    runtime,
    call.server,
    call.trigger,
    "mcpjam_subscribe_to_events",
  );
  if ("error" in resolved) return resolved.error;
  // The same event and params again is the same watch with a new prompt: update
  // it rather than add a second one.
  const existing = runtime.bindings.find((binding) =>
    sameTrigger(binding, call.server, call.trigger),
  );
  if (existing) {
    const fields = {
      instructions: call.prompt,
      title: call.title,
      enabled: true,
    };
    if (!(await runtime.edit(existing.id, fields, scope))) return notApplied();
    return success({
      subscription: describe(runtime, { ...existing, ...fields }),
      updated: true,
      message:
        "This event already had a subscription, so its title and prompt were updated. No second subscription was added.",
    });
  }
  const picked = pickMode(runtime, resolved.server.serverName, resolved.event);
  if ("error" in picked) return failure(picked.error);
  const binding = await runtime.add(
    resolved.server,
    resolved.event,
    { arguments: call.trigger.params, ...picked.delivery },
    call.prompt,
    // The watch belongs to the conversation that made the call, or it fails.
    { title: call.title, fromAgent: true, agentScope: scope },
  );
  const subscription = describe(runtime, binding);
  // The server confirms a new watch after this returns, so say it is on its way
  // rather than leave the model to read "not listening yet" as a problem.
  const message =
    subscription.status === "connecting"
      ? `Subscribed to ${resolved.event.name}. It's connecting and switches to listening on its own. Once it's listening, new events start a turn here while this conversation is open in the Playground; an event that arrives during another turn is skipped.`
      : `Subscribed to ${resolved.event.name}. New events start a turn here while this conversation is open in the Playground; an event that arrives during another turn is skipped.`;
  return success({ subscription, message });
}

function findBinding(runtime: EventAgentRuntime, id: string) {
  return runtime.bindings.find((entry) => entry.id === id);
}

const unknownId = (id: string) =>
  failure(
    `Couldn't find an event subscription with the id "${id}". List your event subscriptions and choose one from the list.`,
  );

async function update(
  runtime: EventAgentRuntime,
  call: Extract<EventAgentCall, { tool: "update" }>,
  scope: string | undefined,
) {
  let binding = findBinding(runtime, call.subscriptionId);
  if (!binding) return unknownId(call.subscriptionId);
  if (call.trigger && !sameTrigger(binding, binding.serverName, call.trigger)) {
    const resolved = await resolveTrigger(
      runtime,
      binding.serverName,
      call.trigger,
      "mcpjam_update_event_subscription",
    );
    if ("error" in resolved) return resolved.error;
    const picked = pickMode(
      runtime,
      resolved.server.serverName,
      resolved.event,
    );
    if ("error" in picked) return failure(picked.error);
    binding = await runtime.retarget(
      binding.id,
      resolved.server,
      resolved.event,
      {
        arguments: call.trigger.params,
        ...picked.delivery,
      },
      { agentScope: scope },
    );
  }
  const fields = {
    ...(call.prompt !== undefined ? { instructions: call.prompt } : {}),
    ...(call.title !== undefined ? { title: call.title } : {}),
    ...(call.isEnabled !== undefined ? { enabled: call.isEnabled } : {}),
  };
  if (
    Object.keys(fields).length > 0 &&
    !(await runtime.edit(binding.id, fields, scope))
  )
    return notApplied();
  return success({
    subscription: describe(runtime, { ...binding, ...fields }),
  });
}

async function remove(
  runtime: EventAgentRuntime,
  call: Extract<EventAgentCall, { tool: "delete" }>,
) {
  const binding = findBinding(runtime, call.subscriptionId);
  if (!binding) return unknownId(call.subscriptionId);
  runtime.remove(binding.id);
  return success({
    deleted: binding.id,
    message:
      "Its events no longer start turns here. The server subscription stays in the Events tab.",
  });
}

export async function runEventAgentTool(
  source: EventAgentRuntime | null,
  name: EventAgentToolName,
  input: unknown,
  chat: EventAgentChat = {},
): Promise<EventAgentToolResult> {
  if (!source) {
    return failure(
      "MCP Events aren't available in this Playground right now. Ask the user to open the Events pane.",
    );
  }
  const parsed = parseEventAgentToolCall(name, input);
  if (!parsed.ok) return failure(parsed.error);
  const call = parsed.call;
  // The conversation that made the call, captured now: a watch it creates or
  // changes belongs to it, even if the user switches chats while this runs.
  const agentScope =
    chat.agentScope ?? useEventAgentBridge.getState().agent?.scope;
  const runtime = forChat(source, {
    selectedServers: chat.selectedServers,
    agentScope,
  });
  try {
    switch (call.tool) {
      case "list_event_types":
        return await listEventTypes(runtime, call.server);
      case "subscribe":
        return await subscribe(runtime, call, agentScope);
      case "update":
        return await update(runtime, call, agentScope);
      case "list_subscriptions":
        return success({
          subscriptions: runtime.bindings.map((binding) =>
            describe(runtime, binding),
          ),
        });
      case "delete":
        return await remove(runtime, call);
    }
  } catch (error) {
    return failure(
      error instanceof Error
        ? error.message
        : "Couldn't load your events. Try again.",
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
    /** The tools to advertise for a turn, limited to the chat's selected servers. */
    snapshot: (selectedServers?: readonly string[]) =>
      eventToolsSnapshot(getRuntime(), { selectedServers }),
    /** Run one call as the current conversation, within its selected servers. */
    execute(
      name: EventAgentToolName,
      toolCallId: string,
      input: unknown,
      selectedServers?: readonly string[],
    ): Promise<EventAgentToolResult> {
      const existing = calls.get(toolCallId);
      if (existing) return existing;
      const run = runEventAgentTool(getRuntime(), name, input, {
        selectedServers,
      });
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

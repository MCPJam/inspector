import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_AGENT_TOOL_NAMES } from "@/shared/event-agent-tools";
import type { EventDescriptorView } from "@/shared/events-api";
import {
  createEventAgentToolExecutor,
  eventToolsSnapshot,
  runEventAgentTool,
  type EventAgentRuntime,
  type EventAgentToolResult,
} from "../event-agent-tools";
import type {
  PlaygroundEventBinding,
  ServerEventCatalog,
} from "../PlaygroundEventsProvider";
import { useEventAgentBridge } from "../event-agent-bridge";

const flightEvent: EventDescriptorView = {
  name: "flight.status_changed",
  description: "A flight was delayed or cancelled.",
  delivery: ["poll", "push", "webhook"],
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      tripId: { type: "string", minLength: 1 },
      flightId: { type: "string", enum: ["MJ204", "MJ318"] },
    },
    required: ["tripId", "flightId"],
  },
  payloadSchema: { type: "object" },
};

function catalog(
  serverName: string,
  events: EventDescriptorView[],
  declared = true,
): ServerEventCatalog {
  return {
    serverName,
    catalog: {
      events,
      support: { handshakeObserved: true, declared, listChanged: false },
    },
  };
}

function binding(
  overrides: Partial<PlaygroundEventBinding> = {},
): PlaygroundEventBinding {
  return {
    id: "binding-1",
    subscriptionId: "sub-1",
    logicalId: "esub_1",
    serverName: "flights",
    eventName: "flight.status_changed",
    instructions: "Rebook if delayed",
    enabled: true,
    afterSeq: 0,
    agentScope: "chat:model:",
    ownerScope: "project:host:true",
    event: flightEvent,
    subscription: {
      id: "sub-1",
      serverId: "flights",
      eventName: "flight.status_changed",
      arguments: { tripId: "t1", flightId: "MJ204" },
      mode: "poll",
      desiredState: "active",
      observedState: "active",
      generation: 1,
      consecutiveFailures: 0,
      locality: "local",
    },
    ...overrides,
  };
}

let runtime: EventAgentRuntime;
beforeEach(() => {
  // The conversation the calls run in; `binding()` defaults to the same scope.
  useEventAgentBridge.setState({
    agent: { scope: "chat:model:", blockedReason: null, send: vi.fn() },
  });
  const catalogs = [
    catalog("flights", [flightEvent]),
    catalog("echo", [], false),
  ];
  runtime = {
    hosted: false,
    host: {
      id: null,
      name: "MCPJam (built-in)",
      modes: ["poll", "push", "webhook"],
      missing: false,
    },
    servers: {
      flights: { connectionStatus: "connected" },
      echo: { connectionStatus: "connected" },
    } as unknown as EventAgentRuntime["servers"],
    bindings: [],
    catalogs,
    feed: { status: "live" } as EventAgentRuntime["feed"],
    loadCatalog: vi.fn(
      async (name: string) =>
        catalogs.find((entry) => entry.serverName === name) ?? {
          serverName: name,
          error: "unknown",
        },
    ),
    add: vi.fn(async (server, event, value, instructions, options) =>
      binding({
        id: "binding-new",
        serverName: server.serverName,
        eventName: event.name,
        instructions,
        title: options?.title,
        createdBy: "agent",
        subscription: {
          ...binding().subscription!,
          arguments: value.arguments,
          mode: value.mode,
        },
      }),
    ),
    retarget: vi.fn(async (id, server, event, value) =>
      binding({
        id,
        title: "Rebook MJ204",
        createdBy: "agent",
        subscription: {
          ...binding().subscription!,
          id: "sub-2",
          arguments: value.arguments,
          mode: value.mode,
        },
      }),
    ),
    edit: vi.fn(async () => true),
    remove: vi.fn(),
  };
});

function payload(result: EventAgentToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

const trip = { tripId: "t1", flightId: "MJ204" };
const subscribeInput = {
  server: "flights",
  title: "Rebook MJ204 if delayed",
  prompt:
    "If the flight is cancelled or delayed 3+ hours, rebook it on the next flight.",
  triggers: [{ event: "flight.status_changed", params: trip }],
};

describe("eventToolsSnapshot", () => {
  it("offers only connected servers whose catalog declares Events", () => {
    expect(eventToolsSnapshot(runtime)).toEqual({
      servers: [{ name: "flights", events: ["flight.status_changed"] }],
    });
    runtime.servers = {
      flights: { connectionStatus: "disconnected" },
    } as unknown as EventAgentRuntime["servers"];
    expect(eventToolsSnapshot(runtime)).toBeUndefined();
    expect(eventToolsSnapshot(null)).toBeUndefined();
  });
});

describe("mcpjam_list_event_types", () => {
  it("returns name, description, delivery modes and inputSchema", async () => {
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.listEventTypes,
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toEqual({
      servers: [
        {
          server: "flights",
          eventTypes: [
            {
              name: "flight.status_changed",
              description: "A flight was delayed or cancelled.",
              delivery: ["poll", "push", "webhook"],
              inputSchema: flightEvent.inputSchema,
            },
          ],
        },
      ],
    });
  });
});

describe("mcpjam_subscribe_to_events", () => {
  it("creates the subscription through the Connect event path, with the host's mode", async () => {
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      subscribeInput,
    );
    expect(result.isError).toBeUndefined();
    expect(runtime.add).toHaveBeenCalledWith(
      catalog("flights", [flightEvent]),
      flightEvent,
      { arguments: trip, mode: "poll" },
      subscribeInput.prompt,
      {
        title: subscribeInput.title,
        fromAgent: true,
        agentScope: "chat:model:",
      },
    );
    expect(payload(result).subscription).toMatchObject({
      subscription_id: "binding-new",
      title: subscribeInput.title,
      server: "flights",
      triggers: [{ event: "flight.status_changed", params: trip }],
      prompt: subscribeInput.prompt,
      is_enabled: true,
      delivery: "poll",
      status: "listening",
      created_by: "agent",
    });
  });

  it("refuses params that miss the inputSchema before contacting the server", async () => {
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      {
        ...subscribeInput,
        triggers: [
          {
            event: "flight.status_changed",
            params: { trip_id: "t1", flightId: "MJ999" },
          },
        ],
      },
    );
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body.error).toContain("nothing was sent to the server");
    expect(body.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('required property "tripId"'),
        expect.stringMatching(/^arguments\.flightId: /),
      ]),
    );
    expect(body.hint).toBe(
      "These arguments aren't accepted: trip_id. Use one of: tripId, flightId.",
    );
    expect(body.inputSchema).toEqual(flightEvent.inputSchema);
    expect(runtime.add).not.toHaveBeenCalled();
  });

  it("names the real event types when the event is unknown", async () => {
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      {
        ...subscribeInput,
        triggers: [{ event: "flight.delayed", params: trip }],
      },
    );
    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain(
      "Its event types: flight.status_changed.",
    );
    expect(runtime.add).not.toHaveBeenCalled();
  });

  it("never picks a local webhook, which needs the user's consent", async () => {
    runtime.loadCatalog = vi.fn(async () =>
      catalog("flights", [{ ...flightEvent, delivery: ["webhook"] }]),
    );
    const local = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      subscribeInput,
    );
    expect(local.isError).toBe(true);
    expect(payload(local).error).toContain("Connect event");
    expect(runtime.add).not.toHaveBeenCalled();

    runtime.hosted = true;
    await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      subscribeInput,
    );
    expect(vi.mocked(runtime.add).mock.calls[0][2]).toEqual({
      arguments: trip,
      mode: "webhook",
    });
  });

  it("updates the existing watch when the same event and params are requested again", async () => {
    runtime.bindings = [binding({ enabled: false })];
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      subscribeInput,
    );
    expect(result.isError).toBeUndefined();
    expect(runtime.add).not.toHaveBeenCalled();
    expect(runtime.edit).toHaveBeenCalledWith(
      "binding-1",
      {
        instructions: subscribeInput.prompt,
        title: subscribeInput.title,
        enabled: true,
      },
      "chat:model:",
    );
    expect(payload(result)).toMatchObject({
      updated: true,
      subscription: { subscription_id: "binding-1", is_enabled: true },
    });
  });

  it("runs a re-fired tool call once", async () => {
    const executor = createEventAgentToolExecutor(() => runtime);
    const [first, second] = await Promise.all([
      executor.execute(
        EVENT_AGENT_TOOL_NAMES.subscribe,
        "call-1",
        subscribeInput,
      ),
      executor.execute(
        EVENT_AGENT_TOOL_NAMES.subscribe,
        "call-1",
        subscribeInput,
      ),
    ]);
    expect(second).toBe(first);
    expect(runtime.add).toHaveBeenCalledTimes(1);
  });
});

describe("managing subscriptions", () => {
  beforeEach(() => {
    runtime.bindings = [binding({ title: "Rebook MJ204", createdBy: "agent" })];
  });

  it("lists them with the Events pane's status", async () => {
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.listSubscriptions,
      {},
    );
    expect(payload(result).subscriptions).toEqual([
      {
        subscription_id: "binding-1",
        title: "Rebook MJ204",
        server: "flights",
        triggers: [{ event: "flight.status_changed", params: trip }],
        prompt: "Rebook if delayed",
        is_enabled: true,
        status: "listening",
        delivery: "poll",
        created_by: "agent",
      },
    ]);
  });

  it("pauses and resumes with is_enabled, through the pane's edit", async () => {
    const paused = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.update,
      { subscription_id: "binding-1", is_enabled: false },
    );
    expect(runtime.edit).toHaveBeenCalledWith(
      "binding-1",
      { enabled: false },
      "chat:model:",
    );
    expect(payload(paused).subscription).toMatchObject({
      is_enabled: false,
      status: "paused",
    });
    const resumed = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.update,
      { subscription_id: "binding-1", is_enabled: true },
    );
    expect(runtime.edit).toHaveBeenLastCalledWith(
      "binding-1",
      { enabled: true },
      "chat:model:",
    );
    expect(payload(resumed).subscription.status).toBe("listening");
    expect(runtime.retarget).not.toHaveBeenCalled();
  });

  it("moves the watch to new params with update, keeping its id", async () => {
    const newTrip = { tripId: "t2", flightId: "MJ318" };
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.update,
      {
        subscription_id: "binding-1",
        triggers: [{ event: "flight.status_changed", params: newTrip }],
        prompt: "Watch the new trip.",
      },
    );
    expect(runtime.retarget).toHaveBeenCalledWith(
      "binding-1",
      catalog("flights", [flightEvent]),
      flightEvent,
      { arguments: newTrip, mode: "poll" },
      { agentScope: "chat:model:" },
    );
    expect(runtime.edit).toHaveBeenCalledWith(
      "binding-1",
      { instructions: "Watch the new trip." },
      "chat:model:",
    );
    expect(payload(result).subscription).toMatchObject({
      subscription_id: "binding-1",
      triggers: [{ event: "flight.status_changed", params: newTrip }],
      prompt: "Watch the new trip.",
    });
    expect(runtime.add).not.toHaveBeenCalled();
  });

  it("validates moved params before contacting the server", async () => {
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.update,
      {
        subscription_id: "binding-1",
        triggers: [
          { event: "flight.status_changed", params: { tripId: "t2" } },
        ],
      },
    );
    expect(result.isError).toBe(true);
    expect(runtime.retarget).not.toHaveBeenCalled();
    expect(runtime.edit).not.toHaveBeenCalled();
  });

  it("stops one like Disconnect from agent, and refuses an unknown id", async () => {
    const stopped = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.delete,
      { subscription_id: "binding-1" },
    );
    expect(runtime.remove).toHaveBeenCalledWith("binding-1");
    expect(payload(stopped).deleted).toBe("binding-1");
    const unknown = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.update,
      { subscription_id: "nope", is_enabled: false },
    );
    expect(unknown.isError).toBe(true);
    expect(runtime.edit).not.toHaveBeenCalled();
  });

  it("answers with an error when the Playground has no events runtime", async () => {
    const result = await runEventAgentTool(
      null,
      EVENT_AGENT_TOOL_NAMES.listSubscriptions,
      {},
    );
    expect(result.isError).toBe(true);
  });
});

describe("one conversation's reach", () => {
  const subscribeInput = {
    server: "flights",
    title: "Rebook MJ204",
    prompt: "Rebook if delayed 3h+",
    triggers: [
      {
        event: "flight.status_changed",
        params: { tripId: "t1", flightId: "MJ204" },
      },
    ],
  };

  it("advertises only the servers selected for the chat", () => {
    expect(
      eventToolsSnapshot(runtime, { selectedServers: ["echo"] }),
    ).toBeUndefined();
    expect(
      eventToolsSnapshot(runtime, {
        selectedServers: ["flights"],
      })?.servers.map((server) => server.name),
    ).toEqual(["flights"]);
  });

  it("refuses to subscribe to a server that isn't selected, before contacting it", async () => {
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      subscribeInput,
      { selectedServers: ["echo"] },
    );
    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain("isn't selected for this chat");
    expect(runtime.loadCatalog).not.toHaveBeenCalled();
    expect(runtime.add).not.toHaveBeenCalled();
  });

  it("keeps another conversation's connections out of reach", async () => {
    runtime.bindings = [
      binding({ id: "theirs", agentScope: "other-chat:model:" }),
    ];
    const listed = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.listSubscriptions,
      {},
    );
    expect(payload(listed).subscriptions).toEqual([]);
    const update = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.update,
      { subscription_id: "theirs", is_enabled: true },
    );
    expect(update.isError).toBe(true);
    expect(runtime.edit).not.toHaveBeenCalled();
    // The same event and params here is this chat's own new connection, not
    // the other chat's watch taken over.
    const subscribed = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      subscribeInput,
    );
    expect(subscribed.isError).toBeUndefined();
    expect(runtime.add).toHaveBeenCalledTimes(1);
    expect(runtime.edit).not.toHaveBeenCalled();
  });

  it("tells the agent when a watch can miss an event", async () => {
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      subscribeInput,
    );
    expect(payload(result).message).toContain(
      "while this conversation is open",
    );
    expect(payload(result).message).toContain("skipped");
  });
});

describe("changes that don't land", () => {
  it("reports an edit the provider dropped instead of claiming it applied", async () => {
    runtime.bindings = [binding()];
    vi.mocked(runtime.edit).mockResolvedValueOnce(false);
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.update,
      { subscription_id: "binding-1", is_enabled: true },
    );
    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain("wasn't applied");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { MCPJAM_EVENTS_EXTENSION_ID } from "@mcpjam/sdk/browser";
import { describeClientEvents } from "@/shared/client-events";

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

const FLIGHTS_URL = new URL("https://flights.example.com/mcp");
const ECHO_URL = new URL("https://echo.example.com/mcp");
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
    projectId: "project",
    host: {
      id: null,
      name: "MCPJam (built-in)",
      modes: ["poll", "push", "webhook"],
      missing: false,
    },
    servers: {
      flights: { connectionStatus: "connected", config: { url: FLIGHTS_URL } },
      echo: { connectionStatus: "connected", config: { url: ECHO_URL } },
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
      { arguments: trip, mode: "push" },
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
      delivery: "push",
      status: "listening",
      created_by: "agent",
    });
  });

  it("says a new watch is connecting until the server confirms it", async () => {
    const pending = binding({
      id: "binding-new",
      subscription: {
        ...binding().subscription!,
        observedState: "pending",
      },
    });
    runtime.add = vi.fn(async () => pending);
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      subscribeInput,
    );
    expect(result.isError).toBeUndefined();
    expect(payload(result).subscription.status).toBe("connecting");
    expect(payload(result).message).toBe(
      "Subscribed to flight.status_changed. It's connecting and switches to listening on its own. Once it's listening, new events start a turn here while this conversation is open in the Playground; an event that arrives during another turn is skipped.",
    );
  });

  it("keeps saying connecting while the live feed is still opening", async () => {
    runtime.feed = { status: "idle" } as EventAgentRuntime["feed"];
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      subscribeInput,
    );
    expect(payload(result).subscription.status).toBe("connecting");
    expect(payload(result).message).toContain("It's connecting");
  });

  it("keeps today's message for a repeat subscribe that is already listening", async () => {
    const result = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.subscribe,
      subscribeInput,
    );
    expect(payload(result).subscription.status).toBe("listening");
    expect(payload(result).message).toBe(
      "Subscribed to flight.status_changed. New events start a turn here while this conversation is open in the Playground; an event that arrives during another turn is skipped.",
    );
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

  describe("picks the mode in the SEP's order", () => {
    const signedIn = {
      connectionStatus: "connected",
      config: {
        url: FLIGHTS_URL,
        requestInit: { headers: { Authorization: "Bearer token" } },
      },
    };
    const receiverKey = `mcpjam-events-callback:${JSON.stringify(["project", "flights"])}`;
    const pickedValue = async () => {
      await runEventAgentTool(
        runtime,
        EVENT_AGENT_TOOL_NAMES.subscribe,
        subscribeInput,
      );
      return vi.mocked(runtime.add).mock.calls[0][2];
    };
    afterEach(() => window.localStorage.clear());

    it("hosted, a server that signs in: webhook", async () => {
      runtime.hosted = true;
      runtime.servers = {
        ...runtime.servers,
        flights: signedIn,
      } as unknown as EventAgentRuntime["servers"];
      expect(await pickedValue()).toEqual({ arguments: trip, mode: "webhook" });
    });

    it("hosted, a server with no sign-in: poll", async () => {
      runtime.hosted = true;
      expect(await pickedValue()).toEqual({ arguments: trip, mode: "poll" });
    });

    it("local, an https receiver saved for a server that signs in: webhook through it", async () => {
      window.localStorage.setItem(receiverKey, "https://tunnel.example.com/");
      runtime.servers = {
        ...runtime.servers,
        flights: signedIn,
      } as unknown as EventAgentRuntime["servers"];
      expect(await pickedValue()).toEqual({
        arguments: trip,
        mode: "webhook",
        receiver: { kind: "custom", baseUrl: "https://tunnel.example.com/" },
      });
    });

    it("local, a plain-http receiver: push, never webhook", async () => {
      window.localStorage.setItem(receiverKey, "http://tunnel.example.com/");
      runtime.servers = {
        ...runtime.servers,
        flights: signedIn,
      } as unknown as EventAgentRuntime["servers"];
      expect(await pickedValue()).toEqual({ arguments: trip, mode: "push" });
    });

    it("local, an https receiver but no sign-in: push", async () => {
      window.localStorage.setItem(receiverKey, "https://tunnel.example.com/");
      expect(await pickedValue()).toEqual({ arguments: trip, mode: "push" });
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

describe("the agent's tools and pickMode agree", () => {
  // Every set of client modes, in both runtimes: the Events view offers the
  // tools exactly when subscribe finds a mode for an event offering them all.
  const sets: Array<Array<"poll" | "push" | "webhook">> = [
    [],
    ["poll"],
    ["push"],
    ["webhook"],
    ["poll", "push"],
    ["poll", "webhook"],
    ["push", "webhook"],
    ["poll", "push", "webhook"],
  ];
  for (const hosted of [false, true]) {
    for (const modes of sets) {
      it(`${hosted ? "hosted" : "local"}, modes [${modes.join(", ")}]`, async () => {
        const config = {
          mcpProfile: {
            profileVersion: 1,
            extensions: {
              [MCPJAM_EVENTS_EXTENSION_ID]: Object.fromEntries(
                modes.map((mode) => [mode, true]),
              ),
            },
          },
        };
        runtime.hosted = hosted;
        runtime.host = { id: "host_1", name: "Client", modes, missing: false };
        const result = await runEventAgentTool(
          runtime,
          EVENT_AGENT_TOOL_NAMES.subscribe,
          subscribeInput,
        );
        const offered = describeClientEvents(config, {
          runtime: hosted ? "hosted" : "local",
        }).agentTools.available;
        expect(result.isError ?? false).toBe(!offered);
        expect(vi.mocked(runtime.add).mock.calls.length).toBe(offered ? 1 : 0);
      });
    }
  }
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

  it("lists a watch as connecting until the server confirms it", async () => {
    runtime.bindings = [
      binding({
        subscription: { ...binding().subscription!, observedState: "pending" },
      }),
    ];
    const pending = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.listSubscriptions,
      {},
    );
    expect(payload(pending).subscriptions[0].status).toBe("connecting");
    runtime.bindings = [binding()];
    runtime.feed = { status: "idle" } as EventAgentRuntime["feed"];
    const idle = await runEventAgentTool(
      runtime,
      EVENT_AGENT_TOOL_NAMES.listSubscriptions,
      {},
    );
    expect(payload(idle).subscriptions[0].status).toBe("connecting");
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
      { arguments: newTrip, mode: "push" },
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

import { expect, it, vi } from "vitest";
import type { ServerEventTypesRead } from "../../server-list-reads.js";
import { withEventsBetaRouting } from "../events-beta-routing.js";

function catalog(header = "Region"): ServerEventTypesRead {
  return {
    status: "listed",
    events: [
      {
        name: "update",
        delivery: ["webhook"],
        inputSchema: {
          properties: { region: { type: "string", "x-mcp-header": header } },
        },
      },
    ],
    truncated: false,
    summary: { eventCount: 1, deliveryModes: ["webhook"] },
  };
}

function setup() {
  const state: { version: symbol | undefined; catalog: ServerEventTypesRead } =
    {
      version: Symbol(),
      catalog: catalog(),
    };
  const list = vi.fn(async () => state.catalog);
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json({ result: {} })
  );
  const send = withEventsBetaRouting(transport, () => state.version, list);
  const request = (
    method: string,
    args: Record<string, unknown> = { region: "west" }
  ) =>
    send("https://events.example/mcp", {
      method: "POST",
      headers: { "mcp-method": method },
      body: JSON.stringify({
        method,
        params: { name: "update", arguments: args },
      }),
    });
  return { state, list, transport, request };
}

const unavailable = {
  ...catalog(),
  status: "failed" as const,
  events: [],
  error: new Error("Events catalog unavailable"),
};

it.each(["list_changed", "events/list"])(
  "unsubscribes with known routing when the catalog fails after %s",
  async (invalidation) => {
    const { state, list, transport, request } = setup();
    await request("events/subscribe");
    state.catalog = unavailable;
    if (invalidation === "list_changed") state.version = Symbol();
    else await request("events/list");

    const response = await request("events/unsubscribe");
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
    const init = transport.mock.lastCall?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("mcp-name")).toBe("update");
    expect(headers.get("mcp-param-region")).toBe("west");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      method: "events/unsubscribe",
      params: { name: "update", arguments: { region: "west" } },
    });
  }
);

it("keeps cleanup routing when a refreshed catalog no longer includes the event", async () => {
  const { state, list, transport, request } = setup();
  await request("events/subscribe");
  state.version = Symbol();
  state.catalog = { ...catalog(), events: [], truncated: true };
  await expect(request("events/poll")).rejects.toThrow(
    "Incomplete Events catalog"
  );
  await request("events/unsubscribe");
  expect(list).toHaveBeenCalledTimes(2);
  expect(
    new Headers(transport.mock.lastCall?.[1]?.headers).get("mcp-param-region")
  ).toBe("west");
});

it("refreshes rejected unsubscribe headers and retries only once", async () => {
  const { state, list, transport, request } = setup();
  await request("events/subscribe");
  state.version = Symbol();
  state.catalog = catalog("Updated-Region");
  transport.mockImplementation(async () =>
    Response.json({ error: { code: -32020 } }, { status: 400 })
  );

  expect((await request("events/unsubscribe")).status).toBe(400);
  expect(list).toHaveBeenCalledTimes(2);
  expect(transport).toHaveBeenCalledTimes(3);
  expect(
    transport.mock.calls.slice(1).map(([, init]) => {
      const headers = new Headers(init?.headers);
      return [
        headers.get("mcp-param-region"),
        headers.get("mcp-param-updated-region"),
      ];
    })
  ).toEqual([
    ["west", null],
    [null, "west"],
  ]);
});

it("does not reuse rejected headers if rediscovery fails", async () => {
  const { state, list, transport, request } = setup();
  await request("events/subscribe");
  state.catalog = unavailable;
  transport.mockImplementation(async () =>
    Response.json({ error: { code: -32020 } }, { status: 400 })
  );

  await expect(request("events/unsubscribe")).rejects.toBe(unavailable.error);
  expect(transport).toHaveBeenCalledTimes(2);
  await expect(request("events/unsubscribe")).rejects.toBe(unavailable.error);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenCalledTimes(3);
});

it.each(["events/subscribe", "events/poll", "events/stream"])(
  "still requires fresh catalog routing for %s",
  async (method) => {
    const { state, transport, request } = setup();
    await request("events/subscribe");
    state.version = Symbol();
    state.catalog = unavailable;
    await expect(request(method)).rejects.toBe(unavailable.error);
    expect(transport).toHaveBeenCalledTimes(1);
  }
);

it("does not read the catalog for unsubscribe without arguments", async () => {
  const { state, list, transport, request } = setup();
  state.catalog = unavailable;
  await request("events/unsubscribe", {});
  expect(list).not.toHaveBeenCalled();
  expect(
    new Headers(transport.mock.lastCall?.[1]?.headers).get("mcp-name")
  ).toBe("update");
});

it("discards remembered routing when the beta capability is cleared", async () => {
  const { state, transport, request } = setup();
  await request("events/subscribe");
  state.version = undefined;
  await request("server/discover");
  state.version = Symbol();
  state.catalog = unavailable;
  await expect(request("events/unsubscribe")).rejects.toBe(unavailable.error);
  expect(transport).toHaveBeenCalledTimes(2);
});

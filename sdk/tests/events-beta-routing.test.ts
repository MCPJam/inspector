import { expect, it } from "vitest";
import { classifyEventsRpcError } from "../src/mcp-client-manager/events-ext-guards.js";
import {
  validBetaHttpEventTypes,
  withEventsBetaRouting,
} from "../src/mcp-client-manager/events-beta-routing.js";

function descriptor(header: string) {
  return {
    name: "update",
    delivery: ["poll"],
    inputSchema: {
      properties: { region: { type: "string", "x-mcp-header": header } },
    },
  };
}

it("excludes invalid HTTP annotations and preserves pagination", () => {
  const valid = descriptor("Region");
  expect(
    validBetaHttpEventTypes({
      events: [descriptor("Bad Header"), valid],
      nextCursor: "2",
    })
  ).toEqual({ events: [valid], nextCursor: "2" });
});

it("rediscovers routing after HeaderMismatch and retries exactly once", async () => {
  let loads = 0;
  const sent: Headers[] = [];
  const version = Symbol();
  const send = withEventsBetaRouting(
    async (_input, init) => {
      sent.push(new Headers(init?.headers));
      return Response.json({ error: { code: -32020 } }, { status: 400 });
    },
    () => version,
    async () => ({
      status: "listed",
      events: [descriptor(++loads === 1 ? "Old" : "New")],
      truncated: false,
      summary: { eventCount: 1, deliveryModes: ["poll"] },
    })
  );
  const response = await send("https://events.example/mcp", {
    method: "POST",
    headers: { "mcp-method": "events/poll" },
    body: JSON.stringify({
      method: "events/poll",
      params: { name: "update", arguments: { region: "west" } },
    }),
  });
  expect(response.status).toBe(400);
  expect(
    sent.map((headers) => [
      headers.get("mcp-name"),
      headers.get("mcp-param-old"),
      headers.get("mcp-param-new"),
    ])
  ).toEqual([
    ["update", "west", null],
    ["update", null, "west"],
  ]);
});

it.each([
  [-32023, "NotFound"],
  [-32024, "Forbidden"],
  [-32025, "ResourceExhausted"],
  [-32026, "Unsupported"],
  [-32027, "CallbackEndpointError"],
])("classifies beta error %i as %s", (code, kind) => {
  expect(classifyEventsRpcError("events/subscribe", { code }, "beta")?.kind).toBe(kind);
  expect(classifyEventsRpcError("events/subscribe", { code }, "legacy")).toBeUndefined();
  expect(classifyEventsRpcError("events/subscribe", { code: code + 12 }, "beta")).toBeUndefined();
  expect(classifyEventsRpcError("events/subscribe", { code: code + 12 }, "legacy")?.kind).toBe(kind);
});

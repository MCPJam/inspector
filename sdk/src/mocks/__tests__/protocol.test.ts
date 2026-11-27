import { describe, expect, it } from "vitest";
import { InMemoryServerEventBus } from "@modelcontextprotocol/server";
import {
  modernHeaders,
  modernRequestBody,
} from "../../mcp-conformance/raw-http.js";
import { buildMock, NO_REAL_SERVER } from "../index.js";
import type {
  MockDefinition,
  MockForwardDecision,
  MockRealServer,
} from "../index.js";
import {
  isModern,
  openListen,
  REVISIONS,
  text,
  useProtocolHarness,
  workDefinition,
} from "./protocol-harness.js";
import type { Revision } from "./protocol-harness.js";

const h = useProtocolHarness();
const MODERN: Revision = "2026-07-28";
const LEGACY = REVISIONS.filter((r) => !isModern(r));

const prompts = {
  greet: {
    messages: [
      {
        role: "user" as const,
        content: { type: "text", text: "hi {{input.who}}" },
      },
    ],
  },
};
const withCompletions: MockDefinition = {
  prompts,
  resourceTemplates: { "doc://{id}": { text: "doc {{input.id}}" } },
  completions: {
    prompts: { greet: { who: ["ada", "alan", "grace"] } },
    resourceTemplates: { "doc://{id}": { id: ["1", "10", "2"] } },
  },
};

describe.each(REVISIONS)("completions (%s)", (revision) => {
  const complete = (
    handler: Parameters<typeof h.rpc>[0],
    ref: object,
    name: string,
    value: string
  ) =>
    h.rpc(handler, revision, "completion/complete", {
      ref,
      argument: { name, value },
    });

  it("completes a prompt argument and a template variable from the definition", async () => {
    const { client, handler } = await h.connect(withCompletions, { revision });
    expect(client.getServerCapabilities()?.completions).toBeDefined();
    expect(
      (
        await complete(
          handler,
          { type: "ref/prompt", name: "greet" },
          "who",
          "a"
        )
      ).result
    ).toMatchObject({
      completion: { values: ["ada", "alan"], total: 2, hasMore: false },
    });
    expect(
      (
        await complete(
          handler,
          { type: "ref/resource", uri: "doc://{id}" },
          "id",
          "1"
        )
      ).result?.completion.values
    ).toEqual(["1", "10"]);
  });

  it("caps a result at 100 and says there is more", async () => {
    const many = Array.from({ length: 150 }, (_, i) => `v${i}`);
    const { handler } = await h.connect(
      {
        ...withCompletions,
        completions: { prompts: { greet: { who: many } } },
      },
      { revision }
    );
    const { completion } = (
      await complete(handler, { type: "ref/prompt", name: "greet" }, "who", "")
    ).result!;
    expect(completion.values).toHaveLength(100);
    expect(completion).toMatchObject({ total: 150, hasMore: true });
  });

  it("gives no suggestions for an argument the definition does not list, and none from a real server without completions", async () => {
    const { handler } = await h.connect(withCompletions, { revision });
    expect(
      (
        await complete(
          handler,
          { type: "ref/prompt", name: "greet" },
          "other",
          ""
        )
      ).result?.completion.values
    ).toEqual([]);
  });

  it("is not offered unless the definition lists suggestions or the real server completes", async () => {
    const { client, handler } = await h.connect(
      workDefinition([{ result: text("x") }]),
      { revision }
    );
    expect(client.getServerCapabilities()?.completions).toBeUndefined();
    expect(
      (
        await complete(
          handler,
          { type: "ref/prompt", name: "greet" },
          "who",
          ""
        )
      ).error?.code
    ).toBe(-32601);
  });

  it("passes an argument the definition does not list to the real server, after the host allows it", async () => {
    h.state.withCompletions = true;
    h.state.completed = [];
    const { handler } = await h.connect(
      { completions: withCompletions.completions },
      { revision, backed: true }
    );
    const ref = { type: "ref/prompt", name: "greet" };
    const real = await complete(handler, ref, "elsewhere", "r");
    expect(real.result?.completion.values).toEqual(["real-1", "real-2"]);
    expect(h.state.completed).toEqual([
      expect.objectContaining({
        ref,
        argument: { name: "elsewhere", value: "r" },
      }),
    ]);
    expect(h.state.asked).toContainEqual({
      kind: "request",
      name: "completion/complete",
    });
    // The definition's own list still answers without a forward.
    h.state.asked = [];
    expect(
      (await complete(handler, ref, "who", "g")).result?.completion.values
    ).toEqual(["grace"]);
    expect(h.state.asked).toEqual([]);
  });

  it("dispatches nothing to the real server when the host refuses the forward", async () => {
    h.state.withCompletions = true;
    h.state.completed = [];
    h.state.decide = (): MockForwardDecision => ({
      allowed: false,
      reason: "blocked_by_policy",
      message:
        "Live calls are blocked in this workspace. Ask an admin to allow them.",
    });
    const { handler } = await h.connect(
      { completions: withCompletions.completions },
      { revision, backed: true }
    );
    const refused = await complete(
      handler,
      { type: "ref/prompt", name: "greet" },
      "elsewhere",
      ""
    );
    expect(refused.error).toMatchObject({
      code: -32013,
      message: expect.stringContaining("blocked"),
    });
    expect(h.state.completed).toEqual([]);
  });
});

describe.each(LEGACY)("resource subscriptions (%s)", (revision) => {
  it("passes subscribe and unsubscribe to the real server, after the host allows them", async () => {
    h.state.withSubscribe = true;
    h.state.subscribed = [];
    const { client, handler } = await h.connect({}, { revision, backed: true });
    expect(client.getServerCapabilities()?.resources).toMatchObject({
      subscribe: true,
    });
    await client.subscribeResource({ uri: "test://greeting" });
    await client.unsubscribeResource({ uri: "test://greeting" });
    expect(h.state.subscribed).toEqual([
      { method: "resources/subscribe", uri: "test://greeting" },
      { method: "resources/unsubscribe", uri: "test://greeting" },
    ]);
    expect(h.state.asked).toEqual([
      { kind: "request", name: "resources/subscribe" },
      { kind: "request", name: "resources/unsubscribe" },
    ]);
    expect(handler).toBeDefined();
  });

  it("subscribes nothing at the real server when the host refuses", async () => {
    h.state.withSubscribe = true;
    h.state.subscribed = [];
    h.state.decide = (): MockForwardDecision => ({
      allowed: false,
      reason: "no_access",
      message:
        "You no longer have access to this server. Ask its owner to share it again.",
    });
    const { handler } = await h.connect({}, { revision, backed: true });
    const refused = await h.rpc(handler, revision, "resources/subscribe", {
      uri: "test://greeting",
    });
    expect(refused.error?.code).toBe(-32013);
    expect(h.state.subscribed).toEqual([]);
  });

  it("acknowledges a subscription to the mock's own resource without calling the real server", async () => {
    h.state.withSubscribe = true;
    h.state.subscribed = [];
    const { handler } = await h.connect(
      { resources: { "doc://mine": { text: "x" } } },
      { revision, backed: true }
    );
    expect(
      (
        await h.rpc(handler, revision, "resources/subscribe", {
          uri: "doc://mine",
        })
      ).result
    ).toEqual({});
    expect(h.state.subscribed).toEqual([]);
  });

  it("does not offer subscriptions a server never declared", async () => {
    const { client, handler } = await h.connect({}, { revision, backed: true });
    expect(
      client.getServerCapabilities()?.resources?.subscribe
    ).toBeUndefined();
    expect(
      (
        await h.rpc(handler, revision, "resources/subscribe", {
          uri: "test://greeting",
        })
      ).error?.code
    ).toBe(-32601);
  });
});

describe("resource subscriptions (2026-07-28)", () => {
  it("replaced resources/subscribe with subscriptions/listen", async () => {
    h.state.withSubscribe = true;
    h.state.subscribed = [];
    const { handler } = await h.connect({}, { revision: MODERN, backed: true });
    for (const method of ["resources/subscribe", "resources/unsubscribe"]) {
      expect(
        (await h.rpc(handler, MODERN, method, { uri: "test://greeting" })).error
          ?.code
      ).toBe(-32601);
    }
    expect(h.state.subscribed).toEqual([]);
  });

  it("tells a stream on one request about an update another request announced, through a shared bus", async () => {
    const bus = new InMemoryServerEventBus();
    const definition = workDefinition([
      {
        steps: [{ kind: "resourceUpdated", uri: "doc://a" }],
        result: text("done"),
      },
    ]);
    const listener = buildMock(definition, NO_REAL_SERVER, { bus });
    const caller = buildMock(definition, NO_REAL_SERVER, { bus });
    const listen = await openListen(listener, {
      resourceSubscriptions: ["doc://a", "doc://b"],
    });
    expect((await listen.next())?.method).toBe(
      "notifications/subscriptions/acknowledged"
    );
    await h.rpc(caller, MODERN, "tools/call", { name: "work", arguments: {} });
    expect(await listen.next()).toMatchObject({
      method: "notifications/resources/updated",
      params: { uri: "doc://a" },
    });
    await listen.close();
  });
});

describe("a forward that changes the real server's list (2026-07-28)", () => {
  it("tells a subscription stream, not the request that was running", async () => {
    const { client, handler } = await h.connect(
      {},
      { revision: MODERN, backed: true }
    );
    const onRequest: string[] = [];
    client.setNotificationHandler(
      "notifications/tools/list_changed",
      () => void onRequest.push("tools")
    );
    const listen = await openListen(handler, { toolsListChanged: true });
    expect((await listen.next())?.method).toBe(
      "notifications/subscriptions/acknowledged"
    );
    await client.callTool({ name: "working", arguments: {} });
    expect((await listen.next())?.method).toBe(
      "notifications/tools/list_changed"
    );
    expect(onRequest).toEqual([]);
    await listen.close();
  });
});

describe("logging/setLevel", () => {
  const logs = workDefinition([
    {
      steps: [{ kind: "log", level: "info", data: "x" }],
      result: text("done"),
    },
  ]);
  it.each(LEGACY)(
    "%s: is answered when the mock logs, and not found when it does not",
    async (revision) => {
      const { handler } = await h.connect(logs, { revision });
      expect(
        (
          await h.rpc(handler, revision, "logging/setLevel", {
            level: "warning",
          })
        ).result
      ).toEqual({});
      const quiet = await h.connect(workDefinition([{ result: text("x") }]), {
        revision,
      });
      expect(
        (
          await h.rpc(quiet.handler, revision, "logging/setLevel", {
            level: "warning",
          })
        ).error?.code
      ).toBe(-32601);
    }
  );

  it("2026-07-28: was removed, so the level rides each request instead", async () => {
    const { handler } = await h.connect(logs, { revision: MODERN });
    expect(
      (await h.rpc(handler, MODERN, "logging/setLevel", { level: "warning" }))
        .error?.code
    ).toBe(-32601);
  });

  it("passes the caller's per-request level on to the real server, and its logs back", async () => {
    const { client } = await h.connect({}, { revision: MODERN, backed: true });
    const logged: unknown[] = [];
    client.setNotificationHandler(
      "notifications/message",
      (n) => void logged.push(n.params.data)
    );
    await client.callTool({
      name: "working",
      arguments: {},
      _meta: { "io.modelcontextprotocol/logLevel": "info" },
    });
    expect(logged).toEqual(["step one"]);
    logged.length = 0;
    await client.callTool({ name: "working", arguments: {} });
    expect(logged).toEqual([]);
  });
});

describe.each(REVISIONS)("a forward (%s)", (revision) => {
  it("passes a result field the spec does not name through untouched", async () => {
    h.state.withProtocolTools = true;
    const { handler } = await h.connect({}, { revision, backed: true });
    const called = await h.rpc(handler, revision, "tools/call", {
      name: "extra",
      arguments: {},
    });
    expect(called.result).toMatchObject({
      content: [{ type: "text", text: "extra" }],
      vendorField: { kept: true },
    });
  });

  it("answers a method the revision lacks with method not found", async () => {
    const { handler } = await h.connect({}, { revision, backed: true });
    const lacking = isModern(revision)
      ? ["ping", "logging/setLevel", "resources/subscribe", "tasks/list"]
      : ["subscriptions/listen", "server/discover"];
    for (const method of lacking) {
      expect(
        (await h.rpc(handler, revision, method, {})).error?.code,
        method
      ).toBe(-32601);
    }
  });
});

describe("a forward that asks a question (2026-07-28)", () => {
  /** The fixture's real server answers `ask` with an `input_required`, which a raw call to it returns whole. */
  function realThatAsks(real: MockRealServer): MockRealServer {
    return {
      ...real,
      callTool: async ({
        name,
        arguments: args,
        inputResponses,
        requestState,
      }) => {
        const response = await h.realHandler!.fetch(
          new Request("http://real.local/mcp", {
            method: "POST",
            headers: modernHeaders({
              protocolVersion: MODERN,
              method: "tools/call",
              name,
            }),
            body: JSON.stringify(
              modernRequestBody({
                id: 1,
                method: "tools/call",
                params: {
                  name,
                  arguments: args,
                  ...(inputResponses && { inputResponses }),
                  ...(requestState && { requestState }),
                },
                protocolVersion: MODERN,
                clientCapabilities: { elicitation: { form: {} } },
              })
            ),
          })
        );
        const raw = await response.text();
        const line = raw.split("\n").find((l) => l.startsWith("data:"));
        const message = JSON.parse(line ? line.slice(5) : raw);
        return message.result;
      },
    };
  }

  it("relays the real server's question to the caller and the answer back, state untouched", async () => {
    h.state.withProtocolTools = true;
    const { client, asked } = await h.connect(
      {},
      {
        revision: MODERN,
        backed: true,
        realWrap: realThatAsks,
        replies: {
          elicit: () => ({ action: "accept", content: { who: "Ada" } }),
        },
      }
    );
    const result = await client.callTool({ name: "ask", arguments: {} });
    expect(result.content).toEqual([
      { type: "text", text: "hello Ada (real-state)" },
    ]);
    expect(asked).toEqual([
      expect.objectContaining({
        method: "elicitation/create",
        params: expect.objectContaining({ message: "Who are you?" }),
      }),
    ]);
    // Each round is a forward, and the host allows each.
    expect((h.state.asked ?? []).filter((a) => a.name === "ask")).toHaveLength(
      2
    );
  });

  it.each(LEGACY)(
    "tells a %s caller it cannot be asked, instead of waiting for an answer",
    async (revision) => {
      h.state.withProtocolTools = true;
      const { client } = await h.connect(
        {},
        { revision, backed: true, realWrap: realThatAsks }
      );
      const result = await client.callTool({ name: "ask", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("2026-07-28");
    }
  );
});

describe("per-revision capabilities of the extensions field", () => {
  const skill: MockDefinition = {
    resources: {
      "skill://s/SKILL.md": { text: "---\nname: s\ndescription: d\n---\nbody" },
    },
  };
  it.each(REVISIONS)(
    "%s: the mock adds the skills extension only where `extensions` exists",
    async (revision) => {
      const { client } = await h.connect(skill, { revision });
      expect(client.getServerCapabilities()?.extensions !== undefined).toBe(
        revision === MODERN
      );
    }
  );
});

/** Keeps the helper the backend will use to hand a mock its bus visible to the type checker. */
export type { MockRealServer };

import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { withEphemeralClient } from "../src/operations.js";
import { serveMultiPageFixtureOnPort, type ServedMultiPageFixture } from "./support/multi-page-fixture.js";
import { getWireField } from "./support/raw-capture.js";

/**
 * Phase 3 §11.1 — modern-era (2026-07-28) wire evidence, Node-side only
 * (uses `node:http`, so this does not run in a browser/worker environment).
 *
 * Companion to `pagination-parity.integration.test.ts`: that suite proves
 * pagination; this one proves the modern-era wire invariants MCPClientManager
 * is supposed to preserve when pinned to `2026-07-28` — SEP-2243 standard
 * headers, no session stickiness, correct negotiated-version reporting, and
 * abort-as-cancellation (no `notifications/cancelled` POST).
 */

describe("modern-era (2026-07-28) wire evidence", () => {
  let served: ServedMultiPageFixture | undefined;
  let manager: MCPClientManager | undefined;

  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    await served?.close();
    served = undefined;
    manager = undefined;
  });

  async function connectModern() {
    served = await serveMultiPageFixtureOnPort();
    manager = new MCPClientManager();
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });
    return { served, manager };
  }

  function byMethod(method: string) {
    return served!.exchanges.filter(
      (e) => getWireField(e.request.json, "method") === method
    );
  }

  it("negotiates 2026-07-28 and getInitializationInfo reports it", async () => {
    const { manager } = await connectModern();
    const info = manager.getInitializationInfo("fixture");
    expect(info?.protocolVersion).toBe("2026-07-28");
  });

  it("tools/call carries Mcp-Method, Mcp-Name, and Mcp-Param-Message headers", async () => {
    const { manager } = await connectModern();
    // Populate the client's response cache with `tool-0`'s inputSchema (the
    // x-mcp-header scan reads from a CACHED tools/list entry, not from the
    // call itself).
    await manager.listTools("fixture");
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const calls = byMethod("tools/call");
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.request.headers;
    expect(headers["mcp-method"]).toBe("tools/call");
    expect(headers["mcp-name"]).toBe("tool-0");
    expect(headers["mcp-param-message"]).toBeDefined();
  });

  // ── SEP-2243 mirroring on a COLD client ────────────────────────────────
  //
  // The test above warms the client's `tools/list` response cache by hand.
  // These prove the MUST holds on the surfaces that never do — a hosted or CLI
  // ephemeral connection that only ever calls the tool, and a surface that
  // walks pagination itself (an explicit-`{ cursor }` list writes no cache).

  it("mirrors Mcp-Param-* on a cold client — no prior listTools", async () => {
    const { manager } = await connectModern();
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const calls = byMethod("tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.headers["mcp-param-message"]).toBeDefined();
    // The mirroring source was warmed: the aggregating walk ran (one request
    // per fixture page) even though the caller never listed.
    expect(byMethod("tools/list").length).toBeGreaterThan(0);
  });

  it("warms the mirroring source at most once per connection", async () => {
    const { manager } = await connectModern();
    await manager.executeTool("fixture", "tool-0", { message: "one" });
    const listsAfterFirstCall = byMethod("tools/list").length;
    await manager.executeTool("fixture", "tool-0", { message: "two" });

    const calls = byMethod("tools/call");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.request.headers["mcp-param-message"]).toBeDefined();
    }
    // The second call reuses the warmed source — it must not re-walk the list.
    expect(byMethod("tools/list")).toHaveLength(listsAfterFirstCall);
  });

  it("mirrors after an explicit-cursor listTools, which writes no cache", async () => {
    const { manager } = await connectModern();
    // A hand-walked page: upstream returns the raw page and deliberately does
    // not write the response cache, so this leaves the mirroring source cold.
    await manager.listTools("fixture", { cursor: "page-1" });
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const calls = byMethod("tools/call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.headers["mcp-param-message"]).toBeDefined();
  });

  it("mirrors Mcp-Param-* when an MRTR collector is registered", async () => {
    // The regression this guards is not an exotic one. Every connected server
    // gets an MRTR collector — registering one is what makes the client
    // advertise `elicitation` at all — so `executeTool` takes the
    // `input_required` path for EVERY modern tools/call, elicitation or not.
    // That path sends its legs through `requestWithSchema`, which does not
    // inherit upstream `callTool`'s mirroring. While it went unmirrored, a
    // conforming 2026 server answered every call with -32020 HeaderMismatch.
    const { manager } = await connectModern();
    manager.setMrtrInputCollector("fixture", async () => {
      throw new Error("tool-0 completes on the first leg; must not elicit");
    });
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const calls = byMethod("tools/call");
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.request.headers;
    expect(headers["mcp-param-message"]).toBeDefined();
    // The standard three must still be intact — the mirrored params ride
    // alongside them, they do not replace the options object that carries them.
    expect(headers["mcp-method"]).toBe("tools/call");
    expect(headers["mcp-name"]).toBe("tool-0");
  });

  it("a no-cursor listTools already warmed it — tools/call adds no second list", async () => {
    const { manager } = await connectModern();
    await manager.listTools("fixture");
    const listsAfterWarm = byMethod("tools/list").length;
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    expect(byMethod("tools/list")).toHaveLength(listsAfterWarm);
    expect(
      byMethod("tools/call")[0]!.request.headers["mcp-param-message"]
    ).toBeDefined();
  });

  it("mrtrToolParamHeaders builds the mirrored headers a hosted resume leg needs", async () => {
    // The public seam behind the hosted MRTR resume: it must produce exactly
    // what the local path sends, from ONE implementation, so the two surfaces
    // cannot disagree about what a conforming request looks like.
    const { manager } = await connectModern();
    expect(
      await manager.mrtrToolParamHeaders("fixture", "tool-0", {
        message: "hi",
      }),
    ).toEqual({ "Mcp-Param-Message": "hi" });
  });

  it("mrtrToolParamHeaders returns {} for a tool that declares nothing", async () => {
    const { manager } = await connectModern();
    expect(
      await manager.mrtrToolParamHeaders("fixture", "tool-1", {}),
    ).toEqual({});
  });

  it("a caller Mcp-Param-* is OVERWRITTEN while mirroring is on", async () => {
    // The reason `--mcp-header <Mcp-Param-*>` implies suppression in the CLI.
    // Upstream merges `{ ...options.headers, ...paramHeaders }`, so with
    // mirroring on the mirrored value wins and the override silently vanishes —
    // a flag whose whole purpose is to make the request wrong would produce a
    // request that is right. Pinned so an upstream precedence change is caught.
    const { manager } = await connectModern();
    await manager.executeTool(
      "fixture",
      "tool-0",
      { message: "hi" },
      { headers: { "Mcp-Param-Message": "deliberately-wrong" } },
    );

    const headers = byMethod("tools/call")[0]!.request.headers;
    expect(headers["mcp-param-message"]).toBe("hi");
  });

  it("never retains or re-sends Mcp-Session-Id on modern requests", async () => {
    const { manager } = await connectModern();
    await manager.listTools("fixture");
    await manager.listPrompts("fixture");
    await manager.executeTool("fixture", "echo", { message: "hi" });

    for (const exchange of served!.exchanges) {
      expect(exchange.request.headers["mcp-session-id"]).toBeUndefined();
      expect(exchange.response.headers["mcp-session-id"]).toBeUndefined();
    }
  });

  it("aborting requestOptions.signal mid tools/call aborts the fetch and sends NO notifications/cancelled", async () => {
    const { manager } = await connectModern();
    const controller = new AbortController();
    const callPromise = manager.executeTool(
      "fixture",
      "slow-tool",
      { delayMs: 60_000 },
      { signal: controller.signal }
    );

    // Deterministic proof the tools/call actually reached the fixture before
    // we abort — a held-open call never lands in `exchanges` (its response
    // never completes), so a fixed sleep here would let the test pass without
    // ever dispatching the request. `waitForToolCall` resolves the instant the
    // handler receives it.
    await served!.waitForToolCall("slow-tool");
    controller.abort();

    // The dispatched, held-open call must reject as a consequence of the abort
    // (not resolve with `slow-tool finished`).
    const outcome = await callPromise.then(
      () => "resolved" as const,
      (err) => err
    );
    expect(outcome).not.toBe("resolved");
    expect(outcome).toBeTruthy();

    // The spec cancellation signal on modern is the aborted per-request
    // stream itself — there must be no explicit notifications/cancelled
    // POST alongside it.
    //
    // The settle window is load-bearing: the protocol layer's legacy
    // cancellation branch POSTs the notification fire-and-forget, so asserting
    // the instant `callPromise` rejects passes even when the client DID send
    // one. Give that POST time to land before reading `exchanges`.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(byMethod("notifications/cancelled")).toHaveLength(0);

    // Positive counterpart: the aborted `tools/call` exchange must have
    // actually terminated. A client that only rejects locally leaves the
    // held-open stream running, and the exchange never completes.
    expect(byMethod("tools/call")).toHaveLength(1);
  });
});

/**
 * SEP-2243 mirroring on the EPHEMERAL surface — `withEphemeralClient` is the
 * shared connect → one op → disconnect lifecycle behind `mcpjam tools call`
 * (via the CLI's `withEphemeralManager`) and structurally identical to the
 * hosted `/api/web/tools/execute` per-request connection. Neither lists tools
 * before calling one, so this is the surface the MUST was actually being
 * skipped on — a wrapper-level assertion on the manager alone would not show
 * it.
 */
describe("SEP-2243 mirroring on an ephemeral (connect → call → disconnect) surface", () => {
  let served: ServedMultiPageFixture | undefined;

  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it("mirrors Mcp-Param-* when the only op on the connection is the tools/call", async () => {
    served = await serveMultiPageFixtureOnPort();

    await withEphemeralClient(
      {
        url: served.url,
        mcpProtocolVersion: "2026-07-28",
        timeout: 10_000,
      },
      async (manager, serverId) => {
        await manager.executeTool(serverId, "tool-0", { message: "hi" });
      },
      { serverId: "__cli__", timeout: 10_000 }
    );

    const calls = served.exchanges.filter(
      (e) => getWireField(e.request.json, "method") === "tools/call"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.headers["mcp-param-message"]).toBeDefined();
  });

  it("legacy (2025-11-25) is untouched: no warm-up list, no Mcp-Param-* header", async () => {
    served = await serveMultiPageFixtureOnPort();

    await withEphemeralClient(
      {
        url: served.url,
        mcpProtocolVersion: "2025-11-25",
        timeout: 10_000,
      },
      async (manager, serverId) => {
        await manager.executeTool(serverId, "tool-0", { message: "hi" });
      },
      { serverId: "__cli__", timeout: 10_000 }
    );

    const methods = served.exchanges.map((e) =>
      getWireField(e.request.json, "method")
    );
    // The mirroring warm-up is modern-only: a legacy connection must issue the
    // exact same wire it did before — a tools/call and nothing else.
    expect(methods.filter((m) => m === "tools/list")).toHaveLength(0);
    const calls = served.exchanges.filter(
      (e) => getWireField(e.request.json, "method") === "tools/call"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.headers["mcp-param-message"]).toBeUndefined();
  });
});

/**
 * `mirrorToolParamHeaders: false` — the wire form of the host config's
 * `mcpProfile.toolParamHeaderMirroring: "omit"`, which simulates a client that
 * does NOT implement SEP-2243 mirroring so a server can be tested against one.
 *
 * Both send paths have to honor it, and they suppress differently: the MRTR
 * path builds the headers itself (so it simply builds none), while the plain
 * path goes through upstream `callTool`, which mirrors internally with no
 * disable knob and is silenced only via a `toolDefinition` with the
 * `x-mcp-header` annotations stripped.
 */
describe("SEP-2243 mirroring disabled (mirrorToolParamHeaders: false)", () => {
  let served: ServedMultiPageFixture | undefined;
  let manager: MCPClientManager | undefined;

  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    await served?.close();
    served = undefined;
    manager = undefined;
  });

  async function connect(
    fixtureOptions: Parameters<typeof serveMultiPageFixtureOnPort>[0] = {}
  ) {
    served = await serveMultiPageFixtureOnPort(fixtureOptions);
    manager = new MCPClientManager();
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      mirrorToolParamHeaders: false,
      timeout: 10_000,
    });
    return { served, manager };
  }

  const toolCalls = () =>
    served!.exchanges.filter(
      (e) => getWireField(e.request.json, "method") === "tools/call"
    );

  it("omits Mcp-Param-* on the plain path, keeping the standard three", async () => {
    const { manager } = await connect();
    await manager.listTools("fixture");
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const calls = toolCalls();
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.request.headers;
    expect(headers["mcp-param-message"]).toBeUndefined();
    // Only the mirrored PARAMS are suppressed. `Mcp-Method`/`Mcp-Name` are
    // transport-level and stay conforming — the knob simulates a client that
    // skipped SEP-2243's tool-param mirroring, not one that speaks no 2026.
    expect(headers["mcp-method"]).toBe("tools/call");
    expect(headers["mcp-name"]).toBe("tool-0");
  });

  it("omits Mcp-Param-* on the MRTR path", async () => {
    const { manager } = await connect();
    manager.setMrtrInputCollector("fixture", async () => {
      throw new Error("tool-0 completes on the first leg; must not elicit");
    });
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const calls = toolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.headers["mcp-param-message"]).toBeUndefined();
    expect(calls[0]!.request.headers["mcp-name"]).toBe("tool-0");
  });

  it("sends no warm-up tools/list BEFORE the MRTR tools/call", async () => {
    // Nothing to resolve means nothing to warm. (A tools/list still follows
    // the call — the MRTR path re-imposes upstream's output-schema assertion
    // and looks the tool up to do it — so the evidence is ORDER, not absence.)
    const { manager, served } = await connect();
    manager.setMrtrInputCollector("fixture", async () => {
      throw new Error("must not elicit");
    });
    await manager.executeTool("fixture", "tool-0", { message: "hi" });

    const methods = served.exchanges.map((e) =>
      getWireField(e.request.json, "method")
    );
    expect(methods.indexOf("tools/call")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("tools/list")).toBeGreaterThan(
      methods.indexOf("tools/call")
    );
  });

  it("surfaces the server's -32020 UN-RECOVERED", async () => {
    // The point of the simulation. Upstream `callTool` normally answers a
    // HEADER_MISMATCH by evicting its tools cache, refetching and retrying —
    // which would send the very headers we are suppressing and turn the
    // simulated failure into a success. Passing `toolDefinition` disables that
    // recovery, so the server's rejection reaches the caller.
    const { manager } = await connect({ requireParamHeaders: true });
    await expect(
      manager.executeTool("fixture", "tool-0", { message: "hi" })
    ).rejects.toThrow(/Mcp-Param-Message header is absent/);

    // Exactly one attempt: no evict-refetch-retry behind the user's back.
    expect(toolCalls()).toHaveLength(1);
  });

  it("the same fixture SUCCEEDS with mirroring left at its default", async () => {
    // Control for the test above — proves the -32020 came from the missing
    // header and not from the fixture rejecting everything.
    served = await serveMultiPageFixtureOnPort({ requireParamHeaders: true });
    manager = new MCPClientManager();
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });
    await expect(
      manager.executeTool("fixture", "tool-0", { message: "hi" })
    ).resolves.toBeTruthy();
    expect(toolCalls()[0]!.request.headers["mcp-param-message"]).toBeDefined();
  });

  it("mrtrToolParamHeaders returns NOTHING under the omit knob", async () => {
    // The hosted resume path builds its own headers through this seam, so the
    // simulation has to reach it too — otherwise a hosted session would
    // silently re-conform a client the user asked to break.
    const { manager } = await connect();
    expect(
      await manager.mrtrToolParamHeaders("fixture", "tool-0", {
        message: "hi",
      }),
    ).toEqual({});
  });

  it("still omits when the tool's schema cannot be resolved at all", async () => {
    // The guarantee this protects: giving up and passing no `toolDefinition`
    // would let upstream mirror from its own cache AND re-arm the -32020
    // recovery, silently turning the simulation back into a conforming client.
    //
    // `hideFromList` makes the lookup GENUINELY fail — `tool-0` is absent from
    // every `tools/list` page but still served (and still header-enforced) on
    // `tools/call` — so this reaches the synthetic-definition branch rather
    // than re-covering the resolvable case.
    const { manager, served } = await connect({
      requireParamHeaders: true,
      hideFromList: ["tool-0"],
    });
    const listed = await manager.listTools("fixture");
    // Precondition: the schema really is unavailable.
    expect(listed.tools.map((t) => t.name)).not.toContain("tool-0");

    await expect(
      manager.executeTool("fixture", "tool-0", { message: "hi" }),
    ).rejects.toThrow(/Mcp-Param-Message header is absent/);

    // Exactly one attempt, with no mirrored header: suppression held and the
    // recovery stayed disabled even though nothing could be stripped.
    const calls = toolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.headers["mcp-param-message"]).toBeUndefined();
    expect(served.exchanges.length).toBeGreaterThan(0);
  });

  it("an unresolvable schema under the DEFAULT still mirrors (control)", async () => {
    // Proves the test above is really exercising the suppression branch: with
    // mirroring left on, the same hidden tool takes upstream's silent miss
    // path — no header, then its evict-refetch-retry recovery, which cannot
    // help because the tool is still absent. The distinguishing evidence is
    // the RETRY: the suppressed path sends exactly one call.
    served = await serveMultiPageFixtureOnPort({
      requireParamHeaders: true,
      hideFromList: ["tool-0"],
    });
    manager = new MCPClientManager();
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: "2026-07-28",
      timeout: 10_000,
    });
    await expect(
      manager.executeTool("fixture", "tool-0", { message: "hi" }),
    ).rejects.toThrow();
    expect(toolCalls().length).toBeGreaterThan(1);
  });

  it("lets a caller-supplied Mcp-Param-* reach the wire (the CLI override)", async () => {
    // What `mcpjam tools call --mcp-header Mcp-Param-Region=wrong` depends on.
    // It only works with mirroring OFF: upstream `callTool` merges
    // `{ ...options.headers, ...paramHeaders }`, so with mirroring ON the
    // correct value overwrites the caller's and the -32020 never happens.
    const { manager } = await connect();
    await manager.executeTool(
      "fixture",
      "tool-0",
      { message: "hi" },
      { headers: { "Mcp-Param-Message": "deliberately-wrong" } },
    );

    const headers = toolCalls()[0]!.request.headers;
    expect(headers["mcp-param-message"]).toBe("deliberately-wrong");
  });

  it("leaves a tool with NO declarations byte-identical to the default path", async () => {
    // `tool-1` declares no `x-mcp-header`, so the stripped `toolDefinition`
    // must be a no-op — the knob may not perturb ordinary calls.
    const { manager } = await connect();
    await manager.executeTool("fixture", "tool-1", {});

    const headers = toolCalls()[0]!.request.headers;
    expect(
      Object.keys(headers).filter((h) => h.startsWith("mcp-param-"))
    ).toHaveLength(0);
    expect(headers["mcp-name"]).toBe("tool-1");
  });
});

/**
 * The per-era cancellation-suppression flags — the host-config knob
 * (`mcpProfile.toolCallCancellation.{legacy,modern}: false`) modeling a host
 * that ends the turn locally and tells the server nothing.
 *
 * Driven through `getToolsForAiSdk`, because that is the seam a chat turn's
 * stop button actually travels: the AI SDK hands the turn's `abortSignal` to
 * the tool's `execute`, and the manager decides there whether it reaches the
 * wire.
 *
 * One resolved flag reaches this layer — which era it came from was decided
 * upstream from the version pin (see host-connection.test.ts). Here the only
 * question is whether the flag is obeyed on each era's wire.
 */
describe("cancellation suppression", () => {
  let served: ServedMultiPageFixture | undefined;
  let manager: MCPClientManager | undefined;

  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    await served?.close();
    served = undefined;
    manager = undefined;
  });

  async function abortSlowToolThroughAiSdk(
    connectOverrides: Record<string, unknown> = {},
    protocolVersion: "2026-07-28" | "2025-11-25" = "2026-07-28"
  ) {
    served = await serveMultiPageFixtureOnPort({ listSlowTool: true });
    manager = new MCPClientManager();
    await manager.connectToServer("fixture", {
      url: served.url,
      mcpProtocolVersion: protocolVersion,
      timeout: 10_000,
      ...connectOverrides,
    });

    const tools = await manager.getToolsForAiSdk("fixture");
    const slowTool = tools["slow-tool"];
    expect(slowTool?.execute).toBeTypeOf("function");

    const controller = new AbortController();
    const callPromise = slowTool!.execute!(
      { delayMs: 60_000 },
      { toolCallId: "call-1", messages: [], abortSignal: controller.signal }
    );
    await served.waitForToolCall("slow-tool");
    controller.abort();

    // Either way the caller is released promptly — a host that cancels nothing
    // still ends its own turn. What differs is whether the server hears it.
    const outcome = await Promise.resolve(callPromise).then(
      () => "resolved" as const,
      (error: unknown) => error
    );
    expect(outcome).not.toBe("resolved");

    // Let any cancellation the client chose to send actually land.
    await new Promise((resolve) => setTimeout(resolve, 500));
    return served.exchanges.map((e) => getWireField(e.request.json, "method"));
  }

  it("2026: the modern flag leaves the server running the tool", async () => {
    const methods = await abortSlowToolThroughAiSdk({
      suppressRequestCancellation: true,
    });

    // Nothing was said. Not the 2026 signal (the held-open `tools/call`
    // exchange never completes, so it never appears here) and not the 2025 one
    // either — withholding the signal withholds both, which is the point:
    // the simulated host is silent, not non-conforming.
    expect(methods).not.toContain("notifications/cancelled");
    expect(methods).not.toContain("tools/call");
  }, 30_000);

  it("2026: still cancels with no flag set (control)", async () => {
    const methods = await abortSlowToolThroughAiSdk();

    // Same abort, same seam, opposite outcome: the stream is aborted, so the
    // exchange terminates and lands in the log. Without this control the test
    // above would pass on a client that had simply stopped calling tools.
    expect(methods).toContain("tools/call");
    expect(methods).not.toContain("notifications/cancelled");
  }, 30_000);

  it("2025: the flag withholds notifications/cancelled", async () => {
    const methods = await abortSlowToolThroughAiSdk(
      { suppressRequestCancellation: true },
      "2025-11-25"
    );

    // On this era the signal would have gone out as an explicit notification,
    // so its absence IS the suppression.
    expect(methods).not.toContain("notifications/cancelled");
  }, 30_000);

  it("2025: sends notifications/cancelled with no flag set (control)", async () => {
    const methods = await abortSlowToolThroughAiSdk({}, "2025-11-25");

    expect(methods).toContain("notifications/cancelled");
  }, 30_000);

});

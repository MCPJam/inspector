import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import { serveMultiPageFixtureOnPort, type ServedMultiPageFixture } from "./support/multi-page-fixture.js";
import { getWireField } from "./support/raw-capture.js";

/**
 * READING THESE ASSERTIONS: an absent `tools/call` means the call is still
 * RUNNING, not that it was never dispatched.
 *
 * `served.exchanges` records COMPLETED request/response pairs, and `slow-tool`
 * is held open — so a suppressed call, which the server keeps working on,
 * never lands there, while a cancelled one does: the abort (or the timeout)
 * closes the stream, the exchange terminates, and only then is it logged.
 * Dispatch is proven separately by `waitForToolCall`, which every case awaits
 * before asserting anything.
 */

describe("on -> off -> on, one manager, reconnect between saves", () => {
  const fixtures: ServedMultiPageFixture[] = [];
  let manager: MCPClientManager | undefined;
  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    for (const f of fixtures) await f.close();
  });

  async function fresh() {
    const f = await serveMultiPageFixtureOnPort({ listSlowTool: true });
    fixtures.push(f);
    return f;
  }

  async function turn(served: ServedMultiPageFixture, override: { legacy?: boolean; modern?: boolean }, callId: string) {
    const tools = await manager!.getToolsForAiSdk("fixture", { toolCallCancellation: override });
    const controller = new AbortController();
    const before = served.exchanges.length;
    const p = tools["slow-tool"]!.execute!({ delayMs: 60_000 }, { toolCallId: callId, messages: [], abortSignal: controller.signal });
    await served.waitForToolCall("slow-tool");
    controller.abort();
    const outcome = await Promise.resolve(p).then(() => "resolved", () => "rejected");
    await new Promise((r) => setTimeout(r, 500));
    return { outcome, methods: served.exchanges.slice(before).map((e) => getWireField(e.request.json, "method")) };
  }

  async function reconnect(staleConfig: Record<string, unknown>) {
    const served = await fresh();
    await manager!.disconnectServer("fixture").catch(() => {});
    await manager!.connectToServer("fixture", { url: served.url, timeout: 10_000, ...staleConfig });
    return served;
  }

  it("cancels again after the off->on save", async () => {
    const f1 = await fresh();
    manager = new MCPClientManager();
    await manager.connectToServer("fixture", { url: f1.url, timeout: 10_000 });

    const run1 = await turn(f1, {}, "c1");
    expect(run1.methods).toContain("tools/call");

    const f2 = await reconnect({});
    const run2 = await turn(f2, { legacy: false, modern: false }, "c2");
    expect(run2.methods).not.toContain("tools/call");
    expect(run2.methods).not.toContain("notifications/cancelled");

    const f3 = await reconnect({ toolCallCancellation: { legacy: false, modern: false } });
    const run3 = await turn(f3, {}, "c3");
    expect(run3.methods).toContain("tools/call");
  }, 60_000);
});

/**
 * The suppressed path must also survive the request TIMEOUT. The protocol
 * layer runs the same cancellation on a timeout as on an abort, so a
 * suppressed call left on the connection's default timer would still cancel —
 * just later. That is what made the knob read as flaky rather than off, and a
 * 500ms observation window after the abort cannot see it.
 *
 * Driven with a deliberately TINY connection timeout so the boundary is
 * reachable in a test: the policy replaces it wholesale, so if it ever stops
 * doing so this fails in a second rather than in a day.
 */
describe("a suppressed call outlives the request timeout", () => {
  const fixtures: ServedMultiPageFixture[] = [];
  let manager: MCPClientManager | undefined;
  afterEach(async () => {
    await manager?.disconnectAllServers().catch(() => {});
    for (const f of fixtures) await f.close();
    fixtures.length = 0;
    manager = undefined;
  });

  async function runPastTimeout(connectOverrides: Record<string, unknown>) {
    const served = await serveMultiPageFixtureOnPort({ listSlowTool: true });
    fixtures.push(served);
    manager = new MCPClientManager();
    // 1s per-request timeout: short enough to expire inside this test.
    await manager.connectToServer("fixture", { url: served.url, timeout: 1_000 });

    const tools = await manager.getToolsForAiSdk("fixture", {
      toolCallCancellation: connectOverrides,
    });
    // A signal that never fires: the turn is still live, so the ONLY thing
    // that could cancel here is the timeout.
    const controller = new AbortController();
    const call = tools["slow-tool"]!.execute!(
      { delayMs: 60_000 },
      { toolCallId: "timeout-1", messages: [], abortSignal: controller.signal }
    );
    void call.catch(() => {});
    await served.waitForToolCall("slow-tool");
    // Well past the 1s timeout.
    await new Promise((r) => setTimeout(r, 2_500));
    return served.exchanges.map((e) => getWireField(e.request.json, "method"));
  }

  it("sends nothing when the era's leaf is off", async () => {
    const methods = await runPastTimeout({ legacy: false, modern: false });
    expect(methods).not.toContain("tools/call");
    expect(methods).not.toContain("notifications/cancelled");
  }, 30_000);

  it("times out and cancels with no leaf set (control)", async () => {
    // Proves the window above is long enough to see a cancellation that
    // really happens — without this the test would pass on a broken fixture.
    const methods = await runPastTimeout({});
    expect(methods).toContain("tools/call");
  }, 30_000);
});

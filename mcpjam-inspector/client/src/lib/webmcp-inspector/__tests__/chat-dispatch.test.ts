/**
 * Every path here must RESOLVE, never throw.
 *
 * A client-fulfilled tool call that produces no result leaves the turn paused
 * forever, waiting on a browser that is not going to answer. So "the session
 * went away" has to arrive as an error result the model can read, not as an
 * exception that escapes the handler.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  invokePageToolForChat,
  setAdvertisedPageTools,
} from "../chat-dispatch";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import type { PageToolSnapshotEntry } from "@/shared/chat-v2";

const ENTRY: PageToolSnapshotEntry = {
  alias: "page_1a2b3c4d",
  sessionId: "session-1",
  toolKey: "https://shop.test::add_to_cart",
  rawName: "add_to_cart",
  origin: "https://shop.test",
};

function textOf(result: { content: { text: string }[] }): string {
  return result.content.map((part) => part.text).join("");
}

/** Point the store at a session and a stubbed invoke. */
function stubStore(
  sessionId: string | undefined,
  invoke: (typeof useWebmcpInspectorStore)["getState"] extends never
    ? never
    : (toolKey: string, input: Record<string, unknown>) => Promise<unknown>,
) {
  vi.spyOn(useWebmcpInspectorStore, "getState").mockReturnValue({
    ...useWebmcpInspectorStore.getState(),
    session: sessionId
      ? ({ sessionId } as ReturnType<
          typeof useWebmcpInspectorStore.getState
        >["session"])
      : undefined,
    invokeToolForResult: invoke as never,
  } as ReturnType<typeof useWebmcpInspectorStore.getState>);
}

describe("invokePageToolForChat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setAdvertisedPageTools([ENTRY]);
  });

  it("returns the tool's output on success", async () => {
    stubStore("session-1", async () => ({
      state: "succeeded",
      output: { added: "ABC-123" },
    }));
    const result = await invokePageToolForChat(ENTRY.alias, { sku: "ABC-123" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("ABC-123");
  });

  it("passes the model's input through to the tool", async () => {
    const invoke = vi.fn(async () => ({ state: "succeeded", output: "ok" }));
    stubStore("session-1", invoke as never);
    await invokePageToolForChat(ENTRY.alias, { sku: "XYZ" });
    expect(invoke).toHaveBeenCalledWith(ENTRY.toolKey, { sku: "XYZ" });
  });

  it("says so when a truncated result was shortened", async () => {
    stubStore("session-1", async () => ({
      state: "succeeded",
      output: "a lot of text",
      outputTruncated: true,
    }));
    // The model should know it is not looking at the whole result.
    expect(textOf(await invokePageToolForChat(ENTRY.alias, {}))).toContain(
      "truncated",
    );
  });

  it("reports an unknown alias as an error result", async () => {
    stubStore("session-1", async () => ({ state: "succeeded", output: "" }));
    const result = await invokePageToolForChat("page_deadbeef", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no longer available/i);
  });

  it("refuses to run against a session that has since been replaced", async () => {
    // Invoking here would run the tool on a DIFFERENT page than the one the
    // model was told about.
    stubStore("session-2", async () => ({ state: "succeeded", output: "" }));
    const result = await invokePageToolForChat(ENTRY.alias, {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/gone|reopen/i);
  });

  it("turns a failure, a cancel and a timeout into readable error results", async () => {
    stubStore("session-1", async () => ({
      state: "failed",
      errorMessage: "the page blew up",
    }));
    expect(textOf(await invokePageToolForChat(ENTRY.alias, {}))).toContain(
      "the page blew up",
    );

    stubStore("session-1", async () => ({ state: "cancelled" }));
    const cancelled = await invokePageToolForChat(ENTRY.alias, {});
    expect(cancelled.isError).toBe(true);
    expect(textOf(cancelled)).toMatch(/cancelled/i);

    stubStore("session-1", async () => ({ state: "timeout" }));
    const timedOut = await invokePageToolForChat(ENTRY.alias, {});
    expect(timedOut.isError).toBe(true);
    expect(textOf(timedOut)).toMatch(/did not respond in time/i);
  });

  it("never throws, whatever the store does", async () => {
    setAdvertisedPageTools([]);
    // Worst case: nothing advertised and no session at all.
    await expect(invokePageToolForChat(ENTRY.alias, {})).resolves.toMatchObject(
      { isError: true },
    );
  });
});

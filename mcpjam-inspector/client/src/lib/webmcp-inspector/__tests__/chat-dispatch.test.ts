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
  __resetPageToolDispatchForTests,
  deferPageToolCallForApproval,
  fulfillApprovedPageToolCall,
  invokePageToolForChat,
  ownsPageToolAlias,
  setAdvertisedPageTools,
  settleDeniedPageToolCall,
  snapshotPageToolsForTurn,
} from "../chat-dispatch";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import type { PageToolSnapshotEntry } from "@/shared/chat-v2";

const ENTRY: PageToolSnapshotEntry = {
  binding: { frameId: "frame-main", registrationSeq: 1 },
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
    tools: [{ toolKey: ENTRY.toolKey, binding: ENTRY.binding }] as never,
    invokeToolForResult: invoke as never,
  } as ReturnType<typeof useWebmcpInspectorStore.getState>);
}

describe("invokePageToolForChat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetPageToolDispatchForTests();
    setAdvertisedPageTools([ENTRY]);
  });

  it.each([
    undefined,
    "Cancellation requested. Page execution may continue; verify the page state before retrying.",
  ])(
    "reports an unknown outcome without claiming failure or retrying",
    async (errorMessage) => {
      const invoke = vi.fn(async () => ({ state: "unknown", errorMessage }));
      stubStore("session-1", invoke);
      const result = await invokePageToolForChat(ENTRY.alias, {});
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("may continue");
      expect(textOf(result)).toContain("before retrying");
      expect(textOf(result)).not.toContain("failed");
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects an approval after the page replaces the advertised registration", async () => {
    const invoke = vi.fn(async () => ({
      state: "succeeded",
      output: "wrong tool",
    }));
    stubStore("session-1", invoke);
    deferPageToolCallForApproval({
      toolName: ENTRY.alias,
      toolCallId: "changed",
      input: {},
    });
    const state = useWebmcpInspectorStore.getState();
    vi.mocked(useWebmcpInspectorStore.getState).mockReturnValue({
      ...state,
      tools: [
        {
          ...state.tools[0],
          binding: { frameId: "frame-main", registrationSeq: 2 },
        },
      ],
    });
    const addToolOutput = vi.fn();
    await fulfillApprovedPageToolCall({ toolCallId: "changed", addToolOutput });
    expect(invoke).not.toHaveBeenCalled();
    expect(addToolOutput.mock.calls[0][0].output).toMatchObject({
      isError: true,
    });
    expect(textOf(addToolOutput.mock.calls[0][0].output)).toMatch(
      /registration.*changed/i,
    );
  });

  it("keeps a deferred approval bound even if a later snapshot reuses its alias", async () => {
    const invoke = vi.fn(async () => ({
      state: "succeeded",
      output: "wrong tool",
    }));
    stubStore("session-1", invoke);
    deferPageToolCallForApproval({
      toolName: ENTRY.alias,
      toolCallId: "reused",
      input: {},
    });
    const replacement = {
      ...ENTRY,
      binding: { frameId: "frame-main", registrationSeq: 2 },
    };
    setAdvertisedPageTools([replacement]);
    const state = useWebmcpInspectorStore.getState();
    vi.mocked(useWebmcpInspectorStore.getState).mockReturnValue({
      ...state,
      tools: [{ ...state.tools[0], binding: replacement.binding }],
    });
    const addToolOutput = vi.fn();
    await fulfillApprovedPageToolCall({ toolCallId: "reused", addToolOutput });
    expect(invoke).not.toHaveBeenCalled();
    expect(addToolOutput.mock.calls[0][0].output.isError).toBe(true);
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
    expect(invoke).toHaveBeenCalledWith(
      ENTRY.toolKey,
      { sku: "XYZ" },
      ENTRY.binding,
    );
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

describe("page-tool approval dispatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __resetPageToolDispatchForTests();
    setAdvertisedPageTools([ENTRY]);
  });

  it("claims a page call without invoking it before approval", () => {
    const invoke = vi.fn(async () => ({ state: "succeeded", output: "ok" }));
    stubStore("session-1", invoke as never);
    expect(
      deferPageToolCallForApproval({
        toolName: ENTRY.alias,
        toolCallId: "tc-approval",
        input: { sku: "ABC-123" },
      }),
    ).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fulfills an approved call exactly once and ships its result", async () => {
    const invoke = vi.fn(async () => ({ state: "succeeded", output: "ok" }));
    stubStore("session-1", invoke as never);
    deferPageToolCallForApproval({
      toolName: ENTRY.alias,
      toolCallId: "tc-approved",
      input: { sku: "ABC-123" },
    });
    const addToolOutput = vi.fn();

    await fulfillApprovedPageToolCall({
      toolCallId: "tc-approved",
      addToolOutput,
    });
    await fulfillApprovedPageToolCall({
      toolCallId: "tc-approved",
      addToolOutput,
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      ENTRY.toolKey,
      { sku: "ABC-123" },
      ENTRY.binding,
    );
    expect(addToolOutput).toHaveBeenCalledTimes(1);
    expect(addToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: ENTRY.alias,
        toolCallId: "tc-approved",
        output: expect.objectContaining({
          content: [{ type: "text", text: "ok" }],
        }),
      }),
    );
  });

  it("turns a denied call into a terminal no-op", async () => {
    const invoke = vi.fn(async () => ({ state: "succeeded", output: "ok" }));
    stubStore("session-1", invoke as never);
    deferPageToolCallForApproval({
      toolName: ENTRY.alias,
      toolCallId: "tc-denied",
      input: {},
    });
    settleDeniedPageToolCall("tc-denied");
    const addToolOutput = vi.fn();

    await fulfillApprovedPageToolCall({
      toolCallId: "tc-denied",
      addToolOutput,
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(addToolOutput).not.toHaveBeenCalled();
  });
});

describe("snapshotPageToolsForTurn", () => {
  const SESSION = {
    sessionId: "session-1",
    status: "ready",
    url: "https://shop.test/",
    createdAt: 1,
    expiresAt: 2,
    hardExpiresAt: 3,
    viewportTransport: { kind: "native-window" },
    protocolVersion: 1,
  } as ReturnType<typeof useWebmcpInspectorStore.getState>["session"];

  const TOOL = {
    binding: ENTRY.binding,
    toolKey: "https://shop.test::add_to_cart",
    name: "add_to_cart",
    origin: "https://shop.test",
    fromSubframe: false,
    registrationKind: "imperative",
  } as ReturnType<typeof useWebmcpInspectorStore.getState>["tools"][number];

  beforeEach(() => {
    vi.restoreAllMocks();
    useWebmcpInspectorStore.setState({
      session: SESSION,
      tools: [TOOL],
      chatEnabled: true,
    });
  });

  it("advertises the open page's tools when opted in", () => {
    const entries = snapshotPageToolsForTurn();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      rawName: "add_to_cart",
      origin: "https://shop.test",
    });
    expect(entries[0].alias).toMatch(/^page_[0-9a-f]{8}$/);
  });

  it("advertises nothing until someone opts in", () => {
    useWebmcpInspectorStore.setState({ chatEnabled: false });
    expect(snapshotPageToolsForTurn()).toEqual([]);
  });

  it("advertises nothing for a session that has closed", () => {
    // The opt-in and the tool list both survive a close, so this is the only
    // thing between a dead browser and a model being offered its tools.
    useWebmcpInspectorStore.setState({
      session: { ...SESSION!, status: "closed" },
    });
    expect(snapshotPageToolsForTurn()).toEqual([]);
  });

  it("advertises nothing when the page has registered no tools", () => {
    useWebmcpInspectorStore.setState({ tools: [] });
    expect(snapshotPageToolsForTurn()).toEqual([]);
  });

  it("advertises nothing when no session is open at all", () => {
    useWebmcpInspectorStore.setState({ session: undefined });
    expect(snapshotPageToolsForTurn()).toEqual([]);
  });
});

describe("ownsPageToolAlias — the two page-tool namespaces stay apart", () => {
  it("does NOT claim the agent browser's server-executed `webmcp_*` tools", () => {
    // `page_*` is fulfilled by THIS client; `webmcp_*` is executed on the
    // server against the agent browser. A client that claimed the second would
    // defer its call for a browser it does not have, and the turn would strand
    // waiting on a result nobody sends.
    expect(ownsPageToolAlias("webmcp_add_topping")).toBe(false);
    expect(ownsPageToolAlias("webmcp_x")).toBe(false);
  });
});

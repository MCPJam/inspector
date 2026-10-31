import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { useForwardedWidgetCalls } from "../use-forwarded-widget-calls";
import { authFetch } from "@/lib/session-token";
vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("../parts/tool-part", () => ({
  ToolPart: ({
    onApprove,
    onDeny,
  }: {
    onApprove: () => void;
    onDeny: () => void;
  }) => (
    <>
      <button onClick={onApprove}>Allow App</button>
      <button onClick={onDeny}>Deny App</button>
    </>
  ),
}));
const context = {
  owner: {
    kind: "chat" as const,
    userId: "user",
    serverId: "server",
    harnessSessionId: "lane",
  },
  parentExecutionId: "parent",
};
const wire = (value: object) =>
  new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
describe("forwarded App calls", () => {
  it("explicitly cancels a pending approval when the widget unmounts behind a proxy", async () => {
    vi.mocked(authFetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith("/approval")) return new Response("{}");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(wire({ type: "approval", id: "pending" }));
            init!.signal!.addEventListener("abort", () =>
              controller.error(new Error("cancelled")),
            );
          },
        }),
      );
    });
    const { result, unmount } = renderHook(() =>
      useForwardedWidgetCalls("chat", true, "parent"),
    );
    let outcome!: Promise<unknown>;
    act(() => {
      outcome = result.current
        .call(context, "change", {})
        .catch((error: Error) => error.message);
    });
    await waitFor(() => expect(result.current.approvals).toHaveLength(1));
    unmount();
    await expect(outcome).resolves.toBe("cancelled");
    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(authFetch).toHaveBeenLastCalledWith(
      "/api/web/harness-forwarding/approval",
      expect.objectContaining({
        keepalive: true,
        body: JSON.stringify({
          id: "pending",
          approved: false,
          cancelled: true,
        }),
      }),
    );
  });
  it("returns the original result including image, structured data and private metadata", async () => {
    const original = {
      content: [
        { type: "text", text: "ok" },
        { type: "image", mimeType: "image/png", data: "AA==" },
      ],
      structuredContent: { count: 1 },
      _meta: { private: "retained" },
      isError: true,
    };
    vi.mocked(authFetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(wire({ type: "result", result: original }));
            c.close();
          },
        }),
      ),
    );
    const { result } = renderHook(() =>
      useForwardedWidgetCalls("chat", true, "parent"),
    );
    await expect(result.current.call(context, "change", {})).resolves.toEqual(
      original,
    );
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
  it("uses the existing deny control and does not retry the action", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.mocked(authFetch).mockImplementation(async (url) => {
      if (String(url).endsWith("/approval")) {
        stream.enqueue(wire({ type: "error", error: "denied" }));
        stream.close();
        return new Response("{}");
      }
      return new Response(
        new ReadableStream({
          start(c) {
            stream = c;
            c.enqueue(wire({ type: "approval", id: "approval" }));
          },
        }),
      );
    });
    let api!: ReturnType<typeof useForwardedWidgetCalls>;
    function Harness() {
      api = useForwardedWidgetCalls("chat", true, "parent");
      return <>{api.approvals}</>;
    }
    render(<Harness />);
    let outcome!: Promise<unknown>;
    act(() => {
      outcome = api.call(context, "change", {}).catch((e: Error) => e.message);
    });
    fireEvent.click(await screen.findByText("Deny App"));
    await expect(outcome).resolves.toBe("denied");
    await waitFor(() => expect(screen.queryByText("Deny App")).toBeNull());
    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(vi.mocked(authFetch).mock.calls[1][1]!.body as string),
    ).toEqual({ id: "approval", approved: false });
  });
  it("aborts an outstanding call when its parent changes", async () => {
    let signal!: AbortSignal;
    vi.mocked(authFetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init!.signal as AbortSignal;
          signal.addEventListener("abort", () =>
            reject(new Error("cancelled")),
          );
        }),
    );
    const { result, rerender } = renderHook(
      ({ parent }) => useForwardedWidgetCalls("chat", true, parent),
      { initialProps: { parent: "parent" } },
    );
    let outcome!: Promise<unknown>;
    act(() => {
      outcome = result.current
        .call(context, "change", {})
        .catch((e: Error) => e.message);
    });
    rerender({ parent: "other" });
    await expect(outcome).resolves.toBe("cancelled");
    expect(signal.aborted).toBe(true);
    expect(authFetch).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ServerWithName } from "@/state/app-types";
import { CONNECT_TYPING_PAUSE_MS, ConnectStep } from "../ConnectStep";

// Status swaps render in place, so each step's content is there at once.
vi.mock("framer-motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("framer-motion")>()),
  useReducedMotion: () => true,
}));
vi.mock("@/components/ui/error-card", () => ({
  ErrorCard: ({ onRetry }: { onRetry?: () => void }) => (
    <button type="button" onClick={onRetry}>
      Retry
    </button>
  ),
}));

const URL_VALUE = "https://mcp.acme.dev/mcp";

function setup(servers: Record<string, ServerWithName> = {}) {
  const props = {
    servers,
    onConnect: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    onReconnect: vi.fn().mockResolvedValue(undefined),
    onConfirmed: vi.fn(),
    onTrack: vi.fn(),
    onAttemptChange: vi.fn(),
  };
  const view = render(<ConnectStep {...props} />);
  return { props, view };
}

function typeUrl(value: string) {
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value },
  });
}

const server = (connectionStatus: ServerWithName["connectionStatus"]) =>
  ({
    name: "Acme",
    config: { url: URL_VALUE },
    connectionStatus,
  }) as unknown as ServerWithName;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ConnectStep", () => {
  it("starts connecting once typing pauses on a valid URL", () => {
    const { props } = setup();
    typeUrl(URL_VALUE);
    expect(props.onConnect).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    expect(props.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme", type: "http", url: URL_VALUE }),
      { suppressErrorToast: true, suppressSuccessToast: true },
    );
    expect(props.onTrack).toHaveBeenCalledWith("auto_started");
    expect(props.onAttemptChange).toHaveBeenLastCalledWith(["Acme"]);
  });

  it("explains an incomplete URL and sends nothing", () => {
    const { props } = setup();
    typeUrl("mcp.acme");
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    expect(props.onConnect).not.toHaveBeenCalled();
    expect(screen.getByText(/Enter a full URL/)).toBeVisible();
  });

  it("asks to confirm a connected server", () => {
    const { props, view } = setup();
    typeUrl(URL_VALUE);
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    view.rerender(
      <ConnectStep {...props} servers={{ Acme: server("connected") }} />,
    );
    expect(screen.getByText("Connected to Acme")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(props.onConfirmed).toHaveBeenCalledWith("Acme");
    expect(props.onTrack).toHaveBeenCalledWith("confirmed");
  });

  it("removes the server it added when the user picks another", () => {
    const { props, view } = setup();
    typeUrl(URL_VALUE);
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    view.rerender(
      <ConnectStep {...props} servers={{ Acme: server("connected") }} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use a different server" }),
    );
    expect(props.onRemove).toHaveBeenCalledWith("Acme");
  });

  it("cancels the attempt when the URL is edited", () => {
    const { props, view } = setup();
    typeUrl(URL_VALUE);
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    view.rerender(
      <ConnectStep {...props} servers={{ Acme: server("connecting") }} />,
    );
    typeUrl(`${URL_VALUE}2`);
    expect(props.onRemove).toHaveBeenCalledWith("Acme");
  });

  it("reconnects a saved server with that URL instead of overwriting it", () => {
    const { props } = setup({ Acme: server("disconnected") });
    typeUrl(URL_VALUE);
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    expect(props.onConnect).not.toHaveBeenCalled();
    expect(props.onReconnect).toHaveBeenCalledWith("Acme");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onReconnect).toHaveBeenCalledTimes(2);
    typeUrl("https://other.example.com/mcp");
    expect(props.onRemove).not.toHaveBeenCalled();
  });

  it("starts connecting right away on paste", () => {
    const { props } = setup();
    const input = screen.getByLabelText("Server URL");
    // jsdom's change event carries no InputEvent, so dispatch the paste one.
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, URL_VALUE);
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromPaste",
        }),
      );
    });
    expect(props.onConnect).toHaveBeenCalledTimes(1);
  });

  it("counts a server again once its removal fails", async () => {
    const { props, view } = setup();
    props.onRemove.mockRejectedValueOnce(new Error("offline"));
    typeUrl(URL_VALUE);
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    view.rerender(
      <ConnectStep {...props} servers={{ Acme: server("connected") }} />,
    );
    view.unmount();
    expect(props.onAttemptChange).toHaveBeenLastCalledWith(["Acme"]);
    await act(async () => {});
    expect(props.onAttemptChange).toHaveBeenLastCalledWith([]);
  });

  it("abandons an unconfirmed attempt when the step closes", () => {
    const { props, view } = setup();
    typeUrl(URL_VALUE);
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    view.rerender(
      <ConnectStep {...props} servers={{ Acme: server("connected") }} />,
    );
    view.unmount();
    expect(props.onRemove).toHaveBeenCalledWith("Acme");
    // Still not counted while its removal is in flight.
    expect(props.onAttemptChange).toHaveBeenLastCalledWith(["Acme"]);
  });

  it("keeps a confirmed server when the step closes", () => {
    const { props, view } = setup();
    typeUrl(URL_VALUE);
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    view.rerender(
      <ConnectStep {...props} servers={{ Acme: server("connected") }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    view.unmount();
    expect(props.onRemove).not.toHaveBeenCalled();
  });

  it("tracks a failed connection once, with its error slug", () => {
    const { props, view } = setup();
    typeUrl(URL_VALUE);
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    const failed = {
      ...server("failed"),
      lastNormalizedError: { slug: "network/unreachable" },
    } as unknown as ServerWithName;
    view.rerender(<ConnectStep {...props} servers={{ Acme: failed }} />);
    view.rerender(<ConnectStep {...props} servers={{ Acme: { ...failed } }} />);
    const failures = props.onTrack.mock.calls.filter(([a]) => a === "failed");
    expect(failures).toEqual([
      ["failed", { error_slug: "network/unreachable" }],
    ]);
  });

  it("accepts a localhost URL", () => {
    const { props } = setup();
    typeUrl("http://localhost:3001/mcp");
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    expect(props.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://localhost:3001/mcp" }),
      expect.anything(),
    );
  });

  it("connects the Excalidraw demo server", () => {
    const { props } = setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Use the Excalidraw demo server" }),
    );
    expect(props.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Excalidraw (App)",
        url: "https://mcp.excalidraw.com/mcp",
      }),
      { suppressErrorToast: true, suppressSuccessToast: true },
    );
    expect(props.onTrack).toHaveBeenCalledWith("demo_started");
    expect(props.onAttemptChange).toHaveBeenLastCalledWith([
      "Excalidraw (App)",
    ]);
  });

  it("offers the demo server after a failed connection", () => {
    const { props, view } = setup();
    typeUrl(URL_VALUE);
    act(() => vi.advanceTimersByTime(CONNECT_TYPING_PAUSE_MS));
    expect(
      screen.queryByRole("button", { name: "Use the Excalidraw demo server" }),
    ).toBeNull();
    view.rerender(
      <ConnectStep {...props} servers={{ Acme: server("failed") }} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use the Excalidraw demo server" }),
    );
    expect(props.onRemove).toHaveBeenCalledWith("Acme");
    // Home must know the demo is unconfirmed before its server can appear,
    // and must not count the failed server until its removal lands.
    expect(props.onAttemptChange).toHaveBeenLastCalledWith([
      "Excalidraw (App)",
      "Acme",
    ]);
    const reported = props.onAttemptChange.mock.invocationCallOrder.at(-1)!;
    const connected = props.onConnect.mock.invocationCallOrder.at(-1)!;
    expect(reported).toBeLessThan(connected);
    view.rerender(<ConnectStep {...props} servers={{}} />);
    expect(props.onAttemptChange).toHaveBeenLastCalledWith([
      "Excalidraw (App)",
    ]);
  });

  it("retries a failed demo connection without removing it", () => {
    const { props, view } = setup();
    const demo = () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Use the Excalidraw demo server" }),
      );
    demo();
    view.rerender(
      <ConnectStep
        {...props}
        servers={{
          "Excalidraw (App)": {
            ...server("failed"),
            name: "Excalidraw (App)",
          } as ServerWithName,
        }}
      />,
    );
    demo();
    expect(props.onRemove).not.toHaveBeenCalled();
    expect(props.onConnect).toHaveBeenCalledTimes(2);
    expect(props.onTrack).toHaveBeenLastCalledWith("retried");
  });
});

import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenTerminalOptions } from "@/lib/computer-terminal-connection";

// xterm can't render under jsdom, and we don't need it to — stub the bits the
// component touches and record writes so we can assert stale output is dropped.
const h = vi.hoisted(() => {
  const writes: Uint8Array[] = [];
  class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    focus() {}
    write(bytes: Uint8Array) {
      writes.push(bytes);
    }
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    dispose() {}
  }
  class FakeFit {
    fit() {}
  }
  const connections: Array<{ opts: OpenTerminalOptions; close: () => void }> =
    [];
  return { writes, FakeTerminal, FakeFit, connections };
});

vi.mock("@xterm/xterm", () => ({ Terminal: h.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: h.FakeFit }));
vi.mock("@/lib/computer-terminal-connection", () => ({
  openTerminalConnection: (opts: OpenTerminalOptions) => {
    const conn = {
      opts,
      sendInput: vi.fn(),
      resize: vi.fn(),
      ping: vi.fn(),
      close: vi.fn(),
    };
    h.connections.push(conn);
    return conn;
  },
}));

import { ComputerTerminal } from "../ComputerTerminal";

afterEach(() => {
  h.connections.length = 0;
  h.writes.length = 0;
});

describe("ComputerTerminal — stale-connection guards", () => {
  it("ignores output and close callbacks from a superseded connection after reconnect", async () => {
    const mintToken = vi.fn(async () => "tok");
    const { getByText, queryByText } = render(
      <ComputerTerminal mintToken={mintToken} themeMode="dark" />
    );

    // First connection comes up after the async token mint, then drops.
    await waitFor(() => expect(h.connections).toHaveLength(1));
    const first = h.connections[0];
    act(() => first.opts.onEvent({ type: "ready", sessionId: "s1" }));
    act(() => first.opts.onClose(1006, "dropped"));

    // The drop surfaces a Reconnect affordance; clicking it opens a 2nd socket.
    const reconnect = await waitFor(() => getByText("Reconnect"));
    fireEvent.click(reconnect);
    await waitFor(() => expect(h.connections).toHaveLength(2));
    const second = h.connections[1];
    act(() => second.opts.onEvent({ type: "ready", sessionId: "s2" }));
    expect(queryByText("Reconnect")).toBeNull(); // connected on the new socket

    // The OLD socket now fires late callbacks. They must be no-ops: no write to
    // the live terminal, and no flip back to a disconnected/overlay state.
    const writesBefore = h.writes.length;
    act(() => {
      first.opts.onOutput(new Uint8Array([65, 66, 67]));
      first.opts.onClose(4401, "expired");
    });

    expect(h.writes.length).toBe(writesBefore);
    expect(queryByText("Reconnect")).toBeNull();

    // The current connection still drives the terminal.
    act(() => second.opts.onOutput(new Uint8Array([100])));
    expect(h.writes.length).toBe(writesBefore + 1);
  });

  it("drops a token mint that resolves after the component unmounts", async () => {
    let resolveToken: (value: string) => void = () => {};
    const mintToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        })
    );
    const { unmount } = render(
      <ComputerTerminal mintToken={mintToken} themeMode="dark" />
    );
    await waitFor(() => expect(mintToken).toHaveBeenCalled());

    // Unmount before the token resolves, then resolve: no connection should open.
    unmount();
    await act(async () => {
      resolveToken("late-token");
      await Promise.resolve();
    });
    expect(h.connections).toHaveLength(0);
  });
});

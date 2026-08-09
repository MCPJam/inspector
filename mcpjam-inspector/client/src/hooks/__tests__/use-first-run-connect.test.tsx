import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useFirstRunConnect } from "../use-first-run-connect";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";
import type { EnsureServerConnectionResult } from "@/hooks/use-server-state";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/PosthogUtils", () => ({
  detectPlatform: () => "web",
  detectEnvironment: () => "test",
}));

function setup(
  overrides: {
    connectResult?: EnsureServerConnectionResult;
    saveResult?: boolean;
    connectServer?: (name: string) => Promise<EnsureServerConnectionResult>;
    hostedMode?: boolean;
  } = {}
) {
  const saveServer = vi.fn().mockResolvedValue(overrides.saveResult ?? true);
  const connectServer =
    overrides.connectServer ??
    vi.fn().mockResolvedValue(overrides.connectResult ?? { status: "connected" });
  const onConnected = vi.fn();
  const onAuthorize = vi.fn();

  const hook = renderHook(() =>
    useFirstRunConnect({
      saveServer,
      connectServer,
      onConnected,
      onAuthorize,
      hostedMode: overrides.hostedMode ?? false,
    })
  );

  return { hook, saveServer, connectServer, onConnected, onAuthorize };
}

describe("useFirstRunConnect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts in the choosing phase with no error", () => {
    const { hook } = setup();
    expect(hook.result.current.phase).toEqual({ kind: "choosing" });
    expect(hook.result.current.inputError).toBeNull();
  });

  it("saves then connects the user's own server and reports success", async () => {
    const { hook, saveServer, connectServer, onConnected } = setup();

    act(() => hook.result.current.connectOwnServer("https://mcp.acme.com/mcp"));

    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(saveServer).toHaveBeenCalledWith(
      expect.objectContaining({ type: "http", url: "https://mcp.acme.com/mcp" })
    );
    expect(connectServer).toHaveBeenCalledWith("Acme");
    expect(onConnected).toHaveBeenCalledWith("Acme", "own");
  });

  it("connects the demo server without touching the input", async () => {
    const { hook, saveServer, onConnected } = setup();

    act(() => hook.result.current.connectDemoServer());

    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(saveServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: EXCALIDRAW_SERVER_NAME })
    );
    expect(onConnected).toHaveBeenCalledWith(EXCALIDRAW_SERVER_NAME, "demo");
  });

  it("surfaces a bad input inline and never attempts a connect", () => {
    const { hook, saveServer } = setup();

    act(() => hook.result.current.connectOwnServer("ws://mcp.acme.com"));

    expect(hook.result.current.inputError).toContain("ws");
    expect(hook.result.current.phase.kind).toBe("choosing");
    expect(saveServer).not.toHaveBeenCalled();
  });

  it("rejects a stdio command in hosted mode", () => {
    const { hook, saveServer } = setup({ hostedMode: true });

    act(() => hook.result.current.connectOwnServer("npx -y @acme/server"));

    expect(hook.result.current.inputError).toContain("HTTP server URL");
    expect(saveServer).not.toHaveBeenCalled();
  });

  it("enters an in-place error with the server's own message on failure", async () => {
    const { hook, onConnected } = setup({
      connectResult: { status: "failed", error: "ECONNREFUSED 127.0.0.1:9000" },
    });

    act(() => hook.result.current.connectOwnServer("http://localhost:9000/mcp"));

    await waitFor(() =>
      expect(hook.result.current.phase.kind).toBe("error")
    );
    expect(hook.result.current.phase).toMatchObject({
      kind: "error",
      reason: "failed",
      message: "ECONNREFUSED 127.0.0.1:9000",
      source: "own",
    });
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("distinguishes reauth from failure so the CTA can be Authorize", async () => {
    const { hook } = setup({
      connectResult: { status: "reauth", error: "401 Unauthorized" },
    });

    act(() => hook.result.current.connectOwnServer("https://mcp.acme.com/mcp"));

    await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));
    expect(hook.result.current.phase).toMatchObject({ reason: "reauth" });
  });

  it("routes authorize to the caller with the failing server name", async () => {
    const { hook, onAuthorize } = setup({
      connectResult: { status: "reauth" },
    });

    act(() => hook.result.current.connectOwnServer("https://mcp.acme.com/mcp"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));
    act(() => hook.result.current.authorize());

    expect(onAuthorize).toHaveBeenCalledWith("Acme");
  });

  it("treats a superseded connect as still in flight, not a failure", async () => {
    const { hook, onConnected } = setup({
      connectResult: { status: "superseded" },
    });

    act(() => hook.result.current.connectOwnServer("https://mcp.acme.com/mcp"));

    await waitFor(() =>
      expect(hook.result.current.phase.kind).toBe("connecting")
    );
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("reports a save failure without pretending it connected", async () => {
    const { hook, connectServer } = setup({ saveResult: false });

    act(() => hook.result.current.connectOwnServer("https://mcp.acme.com/mcp"));

    await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));
    expect(connectServer).not.toHaveBeenCalled();
  });

  it("retry replays the failed attempt rather than resetting to choosing", async () => {
    const connectServer = vi
      .fn()
      .mockResolvedValueOnce({ status: "failed", error: "timeout" })
      .mockResolvedValueOnce({ status: "connected" });
    const { hook, onConnected } = setup({ connectServer });

    act(() => hook.result.current.connectOwnServer("https://mcp.acme.com/mcp"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));

    act(() => hook.result.current.retry());

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("Acme", "own"));
    expect(connectServer).toHaveBeenCalledTimes(2);
  });

  it("lets the user get back to the choose screen from an error", async () => {
    const { hook } = setup({ connectResult: { status: "failed" } });

    act(() => hook.result.current.connectOwnServer("https://mcp.acme.com/mcp"));
    await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));

    act(() => hook.result.current.backToChoosing());

    expect(hook.result.current.phase).toEqual({ kind: "choosing" });
  });

  it("ignores a second submit while a connect is already in flight", async () => {
    let release: (r: EnsureServerConnectionResult) => void = () => {};
    const connectServer = vi.fn().mockImplementation(
      () =>
        new Promise<EnsureServerConnectionResult>((resolve) => {
          release = resolve;
        })
    );
    const { hook, saveServer } = setup({ connectServer });

    act(() => hook.result.current.connectOwnServer("https://mcp.acme.com/mcp"));
    await waitFor(() => expect(saveServer).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.connectOwnServer("https://mcp.acme.com/mcp"));

    expect(saveServer).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ status: "connected" });
    });
  });

  it("surfaces a thrown error instead of hanging on connecting", async () => {
    const connectServer = vi.fn().mockRejectedValue(new Error("network down"));
    const { hook } = setup({ connectServer });

    act(() => hook.result.current.connectOwnServer("https://mcp.acme.com/mcp"));

    await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));
    expect(hook.result.current.phase).toMatchObject({ message: "network down" });
  });
});

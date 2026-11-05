import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { webcrypto } from "node:crypto";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { afterEach, expect, it, vi } from "vitest";
import { createAppToolsRegistry } from "../app-tools-registry";
import { useAppToolPresentation } from "../app-tool-presentation";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("updates hidden ancestors without calling tools, changing owners or reviving closed sources", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const registry = createAppToolsRegistry();
  const bridge = new AppBridge(null, { name: "test", version: "1" }, {});
  const call = vi.spyOn(bridge, "callTool");
  await registry
    .getState()
    .registerInstance({
      bridgeId: "file",
      parentToolCallId: "file-call",
      chatSessionId: "chat",
      serverId: "server",
      appName: "CAD",
      bridge,
      surface: "inline",
      registeredAtMs: 0,
      tools: [{ name: "save_file", inputSchema: { type: "object" } }],
    });
  function Source() {
    const ref = useRef<HTMLDivElement>(null);
    useAppToolPresentation(
      registry,
      "file",
      "File viewer: keycap.stl",
      () => ref.current,
    );
    return <div ref={ref} />;
  }
  const view = render(
    <div data-testid="outer">
      <Source />
    </div>,
  );
  const snapshot = () => registry.getState().snapshotForChatBody("chat")[0];
  const alias = snapshot().alias;
  expect(snapshot().description).toContain("visible");
  act(() => {
    view.getByTestId("outer").hidden = true;
  });
  await waitFor(() => expect(snapshot().description).toContain("hidden"));
  act(() => {
    view.getByTestId("outer").hidden = false;
  });
  await waitFor(() => expect(snapshot().description).toContain("visible"));
  expect(snapshot().alias).toBe(alias);
  expect(snapshot().parentToolCallId).toBe("file-call");
  expect(call).not.toHaveBeenCalled();
  registry.getState().unregisterInstance("file");
  act(() => {
    view.getByTestId("outer").hidden = true;
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(registry.getState().snapshotForChatBody("chat")).toEqual([]);
});

import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PlaygroundClientColumn } from "@/lib/playground-client-columns";
import type { ComparePane } from "@/lib/compare-panes";
import { usePlaygroundBrowserToolSlots } from "../use-playground-browser-tool-slots";

vi.mock("../useBrowserEngine", () => ({
  useBrowserEngine: (_project: string, scope: string) => ({
    engine: scope === "preference" ? "local" : "cloud",
    localAvailable: true,
    consent: { token: "device-grant" },
  }),
}));
vi.mock("../useBrowserToolIds", () => ({
  useBrowserToolIds: (_config: unknown, engine: string) => [
    engine === "local" ? "local-browser" : "cloud-browser",
  ],
}));

it("routes each pane's browser and its tools together, without giving the cloud pane a local grant", () => {
  const config: PlaygroundClientColumn["hostConfig"] = {
    id: "config",
    schemaVersion: 2,
    hostStyle: "chatgpt",
    modelId: "model",
    systemPrompt: "",
    temperature: 0,
    requireToolApproval: false,
    serverIds: [],
    optionalServerIds: [],
    clientCapabilities: {},
    hostContext: {},
    connectionDefaults: { headers: {}, requestTimeout: 30000 },
  };
  const columns = ["saved", "client"].map((compareId) => ({
    compareId,
    hostId: "same",
    hostConfig: config,
  }));
  const panes: ComparePane[] = [
    { paneId: "saved", target: { kind: "environment", environmentId: "env" } },
    { paneId: "client", target: { kind: "host", hostId: "same" } },
  ];
  const { result, rerender } = renderHook(
    ({ order }) => usePlaygroundBrowserToolSlots(order, panes, "p"),
    { initialProps: { order: columns } },
  );
  const check = () => {
    expect(result.current.get("saved")).toEqual({
      builtInToolIds: ["cloud-browser"],
      personalBrowserEngine: { engine: "cloud", consentToken: null },
    });
    expect(result.current.get("client")).toEqual({
      builtInToolIds: ["local-browser"],
      personalBrowserEngine: { engine: "local", consentToken: "device-grant" },
    });
  };
  check();
  rerender({ order: [...columns].reverse() });
  check();
});

import { beforeEach, describe, expect, it } from "vitest";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import {
  appendPluginDiagnostics,
  describePluginError,
  parsePluginDiagnostics,
  pluginErrorDiagnostic,
} from "../plugin-diagnostics";

describe("plugin diagnostics in the Logs panel", () => {
  beforeEach(() => useTrafficLogStore.getState().clear());
  it("appends well-formed diagnostics as Logs rows and drops malformed ones", () => {
    const appended = appendPluginDiagnostics(
      [
        pluginErrorDiagnostic("PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN", "Deep link refused"),
        { level: "loud", code: "X", title: "t", description: "d" },
        "not a diagnostic",
      ],
      { serverId: "s1", serverName: "Bits & Bolts" },
    );
    expect(appended).toHaveLength(1);
    const [row] = useTrafficLogStore.getState().mcpServerItems;
    expect(row).toMatchObject({
      serverId: "s1",
      serverName: "Bits & Bolts",
      method: "plugin-extensions/PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN",
      payload: {
        level: "error",
        code: "PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN",
        message: describePluginError("PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN"),
        title: "Deep link refused",
      },
    });
    // A repeat updates the same row instead of flooding the panel.
    appendPluginDiagnostics(
      [pluginErrorDiagnostic("PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN", "Deep link refused")],
      { serverId: "s1" },
    );
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(1);
  });
  it("bounds input and describes codes by exact match or prefix", () => {
    expect(
      parsePluginDiagnostics(
        Array(100).fill({
          level: "info",
          code: "C",
          title: "t",
          description: "d",
        }),
      ),
    ).toHaveLength(32);
    expect(describePluginError("RESOURCE_NOT_TEXT")).toContain("isn't text");
    expect(describePluginError("PLUGIN_SETTINGS_SOMETHING_NEW")).toBe(
      "The server's settings couldn't be used.",
    );
    expect(describePluginError("UNRELATED")).toBeUndefined();
  });
});

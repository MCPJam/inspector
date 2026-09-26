import { describe, expect, it } from "vitest";
import { withPluginExecutionServers } from "../plugin-execution-servers";

const plugin = {
  serverId: "plugin-srv",
  name: "acme",
  pluginVersionId: "pv-1",
  pluginId: "p-1",
  pluginName: "Acme",
  componentKey: "acme",
};

describe("withPluginExecutionServers", () => {
  it("adds re-gated plugin servers to a mixed environment's selection", () => {
    const config = {
      tests: [],
      environment: {
        servers: ["group-srv"],
        serverBindings: [
          { serverName: "billing", projectServerId: "group-srv" },
        ],
      },
    };
    const next = withPluginExecutionServers(config, [plugin], {
      hasServer: (id) => id === "plugin-srv" || id === "group-srv",
    });
    expect(next.environment.servers).toEqual(["group-srv", "plugin-srv"]);
    expect(next.environment.serverBindings).toContainEqual({
      serverName: "acme",
      projectServerId: "plugin-srv",
    });
    // The frozen config is not rewritten.
    expect(config.environment.servers).toEqual(["group-srv"]);
  });

  it("gives a plugin-only environment its plugin servers, by the manager's key", () => {
    const next = withPluginExecutionServers(
      { environment: { servers: [] } },
      [plugin],
      // Connected under its display name (hosted managers key by name).
      { hasServer: () => false },
    );
    expect(next.environment!.servers).toEqual(["acme"]);
  });

  it("changes nothing without plugin servers", () => {
    const config = { environment: { servers: ["group-srv"] } };
    expect(
      withPluginExecutionServers(config, [], { hasServer: () => true }),
    ).toBe(config);
  });
});

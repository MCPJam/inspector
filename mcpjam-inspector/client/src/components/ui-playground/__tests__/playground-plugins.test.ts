import { describe, expect, it } from "vitest";
import {
  buildExtensionServers,
  playgroundTurnsCarryPlugins,
} from "../playground-plugins";

const pluginServers = [
  {
    serverId: "srv_bits",
    name: "bits-cad",
    pluginId: "plg_bits",
    pluginLabel: "Bits & Bolts",
  },
];

const base = {
  isEnvironmentMode: false,
  environmentServers: [],
  selectedServers: ["linear"],
  serversByName: new Map([["linear", "srv_linear"]]),
  servers: {
    linear: {
      connectionStatus: "connected",
      lastConnectionTime: new Date(1_000),
    },
  },
  pluginServers,
};

describe("buildExtensionServers", () => {
  it("adds the active plugins' servers after the selected ones outside environment mode", () => {
    expect(buildExtensionServers(base)).toEqual([
      { serverId: "srv_linear", name: "linear", connection: "1000" },
      { serverId: "srv_bits", name: "bits-cad" },
    ]);
  });

  it("adds them when no server is selected at all", () => {
    expect(buildExtensionServers({ ...base, selectedServers: [] })).toEqual([
      { serverId: "srv_bits", name: "bits-cad" },
    ]);
  });

  it("carries the plugin's icons on its servers", () => {
    const icons = {
      logo: { url: "https://cdn.example/logo.png", contentType: "image/png" },
    };
    const [, bits] = buildExtensionServers({
      ...base,
      pluginIconsById: new Map([["plg_bits", icons]]),
    });
    expect(bits).toEqual({
      serverId: "srv_bits",
      name: "bits-cad",
      pluginIcons: icons,
    });
  });

  it("lists a plugin server the user also selected once", () => {
    const servers = buildExtensionServers({
      ...base,
      selectedServers: ["bits-cad"],
      serversByName: new Map([["bits-cad", "srv_bits"]]),
      servers: {},
    });
    expect(servers.map((server) => server.serverId)).toEqual(["srv_bits"]);
  });

  it("leaves environment mode to the environment's own servers", () => {
    expect(
      buildExtensionServers({
        ...base,
        isEnvironmentMode: true,
        environmentServers: [
          { serverId: "srv_env", name: "env-server", enabled: true },
          { serverId: "srv_off", name: "off", enabled: false },
        ],
      }),
    ).toEqual([{ serverId: "srv_env", name: "env-server" }]);
  });
});

describe("playgroundTurnsCarryPlugins", () => {
  it("carries plugins on a normal chat with active plugins", () => {
    expect(
      playgroundTurnsCarryPlugins({
        isEnvironmentMode: false,
        hasActivePlugins: true,
        localHarnessRequested: false,
      }),
    ).toBe(true);
  });

  it("does not without active plugins", () => {
    expect(
      playgroundTurnsCarryPlugins({
        isEnvironmentMode: false,
        hasActivePlugins: false,
        localHarnessRequested: false,
      }),
    ).toBe(false);
  });

  it("leaves environment mode alone", () => {
    expect(
      playgroundTurnsCarryPlugins({
        isEnvironmentMode: true,
        hasActivePlugins: true,
        localHarnessRequested: false,
      }),
    ).toBe(false);
  });

  it("keeps an explicit run-on-this-machine turn on the local route", () => {
    expect(
      playgroundTurnsCarryPlugins({
        isEnvironmentMode: false,
        hasActivePlugins: true,
        localHarnessRequested: true,
      }),
    ).toBe(false);
  });
});

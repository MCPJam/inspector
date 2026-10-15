import { describe, expect, it } from "vitest";
import {
  admittedPluginDeepLink,
  admittedPluginNavigationNamespace,
  resolvePluginDeepLinkTarget,
  selectPluginDeepLinkServer,
  type PluginDeepLinkCandidate,
} from "../deep-link";
const target = {
  serverIdentity: {
    kind: "plugin",
    serverId: "s",
    pluginId: "p",
    pluginVersionId: "v",
    bundleHash: "b",
    componentKey: "c",
  },
  runtime: "chatgpt",
  toolName: "open",
  kind: "global",
} as const;
describe("admitted App deep links", () => {
  it.each(["thread", "global", "quick-action", "file"] as const)(
    "gives an admitted plugin %s source its own navigation namespace",
    (kind) => {
      expect(
        admittedPluginNavigationNamespace(
          target.serverIdentity,
          "chatgpt",
          kind,
        ),
      ).toEqual({ pluginId: "p", runtime: "chatgpt" });
      expect(
        admittedPluginNavigationNamespace(target.serverIdentity, "codex", kind),
      ).toEqual({ pluginId: "p", runtime: "codex" });
    },
  );
  it("returns app-relative context after exact admission", () => {
    expect(
      admittedPluginDeepLink(
        "chatgpt://plugins/p/app/open?path=%2Fparts%3Fid%3D7",
        target,
      )?.url,
    ).toBe("/parts?id=7");
    expect(admittedPluginDeepLink(undefined, target)).toBeUndefined();
  });
  it.each([
    ["chatgpt://plugins/other/app/open", "PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN"],
    [
      "chatgpt://plugins/p@appstore/app/open",
      "PLUGIN_DEEP_LINK_MARKETPLACE_MISMATCH",
    ],
    ["chatgpt://plugins/p/app/other", "PLUGIN_DEEP_LINK_TOOL_UNAVAILABLE"],
    ["codex://plugins/p/app/open", "PLUGIN_DEEP_LINK_SCHEME_UNSUPPORTED"],
  ])("refuses foreign namespace %s with %s", (url, code) => {
    expect(() => admittedPluginDeepLink(url, target)).toThrow(code);
  });
  it("accepts the manifest name, a published ID and a matching marketplace", () => {
    const names = {
      name: "bits-and-bolts",
      publishedId: "plugin_123",
      marketplace: "team-market",
    };
    for (const url of [
      "chatgpt://plugins/bits-and-bolts/app/open?path=%2Fparts",
      "https://chatgpt.com/plugins/plugin_123/app/open",
      "chatgpt://plugins/bits-and-bolts@team-market/app/open",
      "chatgpt://plugins/p/app/open",
    ])
      expect(admittedPluginDeepLink(url, { ...target, names })?.toolName).toBe(
        "open",
      );
    expect(() =>
      admittedPluginDeepLink(
        "chatgpt://plugins/bits-and-bolts@other-market/app/open",
        { ...target, names },
      ),
    ).toThrow("PLUGIN_DEEP_LINK_MARKETPLACE_MISMATCH");
  });
  it("accepts each client runtime's own schemes only", () => {
    const codex = "codex://plugins/p/app/open";
    // The ChatGPT client never accepts codex://, whatever the deployment.
    expect(() => admittedPluginDeepLink(codex, target)).toThrow(
      "PLUGIN_DEEP_LINK_SCHEME_UNSUPPORTED",
    );
    expect(
      admittedPluginDeepLink(codex, { ...target, runtime: "codex" })?.scheme,
    ).toBe("codex");
    for (const url of [
      "chatgpt://plugins/p/app/open",
      "https://chatgpt.com/plugins/p/app/open",
    ]) {
      expect(admittedPluginDeepLink(url, target)?.toolName).toBe("open");
      expect(() =>
        admittedPluginDeepLink(url, { ...target, runtime: "codex" }),
      ).toThrow("PLUGIN_DEEP_LINK_SCHEME_UNSUPPORTED");
    }
  });
  it("gives plain servers a stable emulated plugin ID from the saved server ID", () => {
    const standalone = { kind: "standalone" as const, serverId: "k123" };
    expect(
      admittedPluginNavigationNamespace(standalone, "chatgpt", "global"),
    ).toEqual({ pluginId: "server-k123", runtime: "chatgpt" });
    expect(
      admittedPluginDeepLink("chatgpt://plugins/server-k123/app/open", {
        ...target,
        serverIdentity: standalone,
      })?.url,
    ).toBe("/");
    // The display name is neither stable nor unique, so it is never an alias.
    expect(() =>
      admittedPluginDeepLink("chatgpt://plugins/k123/app/open", {
        ...target,
        serverIdentity: standalone,
      }),
    ).toThrow("PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN");
  });
  it("accepts file activation without a link but refuses file deep links", () => {
    expect(
      admittedPluginDeepLink(undefined, { ...target, kind: "file" }),
    ).toBeUndefined();
    expect(() =>
      admittedPluginDeepLink("chatgpt://plugins/p/app/open", {
        ...target,
        kind: "file",
      }),
    ).toThrow();
  });
  it("does not let a standalone server answer to a bare server ID or enable thread links", () => {
    expect(() =>
      admittedPluginDeepLink("chatgpt://plugins/p/app/open", {
        ...target,
        serverIdentity: { kind: "standalone", serverId: "p" },
      }),
    ).toThrow();
    expect(() =>
      admittedPluginDeepLink("chatgpt://plugins/p/app/open", {
        ...target,
        kind: "thread",
      }),
    ).toThrow();
  });
});

const plugin = (
  serverId: string,
  pluginId: string,
  names?: PluginDeepLinkCandidate["names"],
): PluginDeepLinkCandidate => ({
  serverId,
  serverName: `Server ${serverId}`,
  serverIdentity: {
    kind: "plugin",
    serverId,
    pluginId,
    pluginVersionId: `${pluginId}-v1`,
    bundleHash: "b",
    componentKey: serverId,
  },
  ...(names ? { names } : {}),
});
describe("deep links clicked in chat", () => {
  const context = (candidates: PluginDeepLinkCandidate[]) => ({
    runtime: "chatgpt" as const,
    candidates,
  });
  it("resolves a manifest name, installation ID or emulated server ID to its servers", () => {
    const candidates = [
      plugin("s1", "inst-1", { name: "bits-and-bolts" }),
      plugin("s2", "inst-2", { name: "other" }),
      {
        serverId: "plain",
        serverIdentity: { kind: "standalone" as const, serverId: "plain" },
      },
    ];
    expect(
      resolvePluginDeepLinkTarget(
        "chatgpt://plugins/bits-and-bolts/app/cad.library?path=%2Fparts",
        context(candidates),
      ).servers.map((server) => server.serverId),
    ).toEqual(["s1"]);
    expect(
      resolvePluginDeepLinkTarget(
        "https://chatgpt.com/plugins/inst-2/app/x",
        context(candidates),
      ).servers[0].serverId,
    ).toBe("s2");
    expect(
      resolvePluginDeepLinkTarget(
        "chatgpt://plugins/server-plain/app/x",
        context(candidates),
      ).servers[0].serverId,
    ).toBe("plain");
    expect(() =>
      resolvePluginDeepLinkTarget(
        "chatgpt://plugins/unknown/app/x",
        context(candidates),
      ),
    ).toThrow("PLUGIN_DEEP_LINK_PLUGIN_UNKNOWN");
  });
  it("refuses an alias shared by two installed plugins, naming both, until @marketplace picks one", () => {
    const candidates = [
      plugin("s1", "inst-1", {
        name: "bolts",
        displayName: "Bolts",
        marketplace: "alpha",
      }),
      plugin("s2", "inst-2", {
        name: "bolts",
        displayName: "Bolts",
        marketplace: "beta",
      }),
    ];
    let refusal: unknown;
    try {
      resolvePluginDeepLinkTarget(
        "chatgpt://plugins/bolts/app/x",
        context(candidates),
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: "PLUGIN_DEEP_LINK_AMBIGUOUS",
      candidates: ["Bolts (@alpha)", "Bolts (@beta)"],
    });
    expect(
      resolvePluginDeepLinkTarget(
        "chatgpt://plugins/bolts@beta/app/x",
        context(candidates),
      ).servers[0].serverId,
    ).toBe("s2");
    expect(() =>
      resolvePluginDeepLinkTarget(
        "chatgpt://plugins/bolts@gamma/app/x",
        context(candidates),
      ),
    ).toThrow("PLUGIN_DEEP_LINK_MARKETPLACE_MISMATCH");
  });
  it("refuses two installs of the same name without marketplaces", () => {
    expect(() =>
      resolvePluginDeepLinkTarget(
        "chatgpt://plugins/bolts/app/x",
        context([
          plugin("s1", "inst-1", { name: "bolts" }),
          plugin("s2", "inst-2", { name: "bolts" }),
        ]),
      ),
    ).toThrow("PLUGIN_DEEP_LINK_AMBIGUOUS");
  });
  it("keeps one plugin's several servers together and picks the one declaring the App", () => {
    const servers = resolvePluginDeepLinkTarget(
      "chatgpt://plugins/bolts/app/library",
      context([
        plugin("s1", "inst-1", { name: "bolts" }),
        plugin("s2", "inst-1", { name: "bolts" }),
      ]),
    ).servers;
    expect(servers).toHaveLength(2);
    expect(
      selectPluginDeepLinkServer(servers, (s) => s.serverId === "s2").serverId,
    ).toBe("s2");
    expect(() => selectPluginDeepLinkServer(servers, () => false)).toThrow(
      "PLUGIN_DEEP_LINK_TOOL_UNAVAILABLE",
    );
    expect(() => selectPluginDeepLinkServer(servers, () => true)).toThrow(
      "PLUGIN_DEEP_LINK_AMBIGUOUS",
    );
  });
  it("refuses a scheme this client does not accept", () => {
    expect(() =>
      resolvePluginDeepLinkTarget(
        "codex://plugins/inst-1/app/x",
        context([plugin("s1", "inst-1")]),
      ),
    ).toThrow("PLUGIN_DEEP_LINK_SCHEME_UNSUPPORTED");
    expect(
      resolvePluginDeepLinkTarget("codex://plugins/inst-1/app/x", {
        ...context([plugin("s1", "inst-1")]),
        runtime: "codex",
      }).servers[0].serverId,
    ).toBe("s1");
  });
});

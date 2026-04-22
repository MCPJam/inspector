import { describe, expect, it } from "vitest";
import { deriveSessionServerDisplay } from "../session-server-display";

describe("session server display helpers", () => {
  it("prefers used server refs over selected server refs", () => {
    const display = deriveSessionServerDisplay({
      usedServerRefs: ["server_1"],
      selectedServers: ["server_2"],
      serversById: new Map([
        ["server_1", "github"],
        ["server_2", "slack"],
      ]),
      knownServerNames: ["github", "slack"],
    });

    expect(display.source).toBe("used");
    expect(display.items).toEqual([
      {
        label: "github",
        raw: "server_1",
        unresolved: false,
      },
    ]);
  });

  it("falls back to selected servers when no used servers were recorded", () => {
    const display = deriveSessionServerDisplay({
      usedServerRefs: [],
      selectedServers: ["slack"],
      serversById: new Map<string, string>(),
      knownServerNames: ["github", "slack"],
    });

    expect(display.source).toBe("selected");
    expect(display.items).toEqual([
      {
        label: "slack",
        raw: "slack",
        unresolved: false,
      },
    ]);
  });

  it("keeps unresolved refs visible instead of dropping them", () => {
    const display = deriveSessionServerDisplay({
      usedServerRefs: ["srv_123"],
      selectedServers: [],
      serversById: new Map<string, string>(),
      knownServerNames: [],
    });

    expect(display.items).toEqual([
      {
        label: "srv_123",
        raw: "srv_123",
        unresolved: true,
      },
    ]);
    expect(display.unresolvedCount).toBe(1);
  });

  it("filters the guest sentinel from both used and selected refs", () => {
    const display = deriveSessionServerDisplay({
      usedServerRefs: ["__guest__", "server_1"],
      selectedServers: ["__guest__", "server_2"],
      serversById: new Map([
        ["server_1", "github"],
        ["server_2", "slack"],
      ]),
      knownServerNames: ["github", "slack"],
    });

    expect(display.source).toBe("used");
    expect(display.items).toEqual([
      {
        label: "github",
        raw: "server_1",
        unresolved: false,
      },
    ]);
  });
});

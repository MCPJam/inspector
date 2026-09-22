import { describe, expect, it } from "vitest";
import { resumableServers } from "../web-chat-turn.js";

// `resumeConfig.selectedServers` is a DURABLE reconnect instruction replayed
// with no plugin lifecycle check. Two things must never reach it: a plugin
// server id (it would outlive the plugin's disable/uninstall) and, through the
// same field, a Playground's EPHEMERAL plugin narrowing (whatever the user
// toggled off for one turn would become the session's stored server set).
describe("resumableServers", () => {
  it("prefers index-aligned names and is unchanged without exclusions", () => {
    expect(
      resumableServers({
        selectedServerIds: ["srv_1", "srv_2"],
        selectedServerNames: ["linear", "asana"],
      })
    ).toEqual(["linear", "asana"]);
  });

  it("falls back to ids when the names are not index-aligned", () => {
    expect(
      resumableServers({
        selectedServerIds: ["srv_1", "srv_2"],
        selectedServerNames: ["linear"],
      })
    ).toEqual(["srv_1", "srv_2"]);
  });

  it("drops plugin servers while keeping the host's own", () => {
    expect(
      resumableServers({
        selectedServerIds: ["srv_host", "srv_plugin"],
        selectedServerNames: ["linear", "plugin-tools"],
        nonResumableServerIds: ["srv_plugin"],
      })
    ).toEqual(["linear"]);
  });

  it("filters by INDEX, so a shared display name drops the right entry", () => {
    expect(
      resumableServers({
        selectedServerIds: ["srv_host", "srv_plugin"],
        selectedServerNames: ["shared", "shared"],
        nonResumableServerIds: ["srv_plugin"],
      })
    ).toEqual(["shared"]);
  });

  it("can empty the list when every server came from a plugin", () => {
    expect(
      resumableServers({
        selectedServerIds: ["srv_plugin"],
        selectedServerNames: ["plugin-tools"],
        nonResumableServerIds: ["srv_plugin"],
      })
    ).toEqual([]);
  });
});

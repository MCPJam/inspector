import { describe, expect, it } from "vitest";
import {
  MCP_CHECK_IDS,
  REMOVED_MCP_CHECK_IDS,
} from "../../src/mcp-conformance/types.js";
import { normalizeMCPConformanceConfig } from "../../src/mcp-conformance/validation.js";
import { normalizeMCPTasksConformanceConfig } from "../../src/tasks-conformance/validation.js";

const serverUrl = "https://example.test/mcp";

describe("check ids an older SDK accepted", () => {
  it("runs the log level advice for the retired log level filtering check", () => {
    const config = normalizeMCPConformanceConfig({
      serverUrl,
      checkIds: ["ping", "modern-log-level-filtering"],
      readinessIds: [],
    });
    expect(config.checkIds).toEqual(["ping"]);
    expect(config.readinessIds).toEqual(["readiness-log-level-filtering"]);
  });

  it("leaves every advice on when none was narrowed", () => {
    const config = normalizeMCPConformanceConfig({
      serverUrl,
      checkIds: ["ping", "modern-log-level-filtering"],
    });
    expect(config.checkIds).toEqual(["ping"]);
    expect(config.readinessIds).toBeUndefined();
  });

  it("keeps a run of only the retired id to the logging check, not every check", () => {
    const config = normalizeMCPConformanceConfig({
      serverUrl,
      checkIds: ["modern-log-level-filtering"],
    });
    expect(config.checkIds).toEqual(["modern-logs-require-log-level"]);
  });

  it("still rejects an id no SDK ever had", () => {
    expect(() =>
      normalizeMCPConformanceConfig({
        serverUrl,
        checkIds: ["bogus" as never],
      })
    ).toThrow("Unknown MCP conformance check id: bogus");
  });

  it("drops a removed check and runs the others that were picked", () => {
    // Multiple POST Streams graded a client rule, so nothing runs in its place.
    const config = normalizeMCPConformanceConfig({
      serverUrl,
      checkIds: ["ping", "server-accepts-multiple-post-streams"],
    });
    expect(config.checkIds).toEqual(["ping"]);
  });

  it("refuses a run of only the removed check, and says why it went away", () => {
    // An emptied list would run every check, which is not what was asked for.
    expect(() =>
      normalizeMCPConformanceConfig({
        serverUrl,
        checkIds: ["server-accepts-multiple-post-streams"],
      })
    ).toThrow(
      /server-accepts-multiple-post-streams was removed and nothing runs in its place. It graded a rule that binds the client, not the server/
    );
  });

  it("drops a removed check next to a retired one", () => {
    const config = normalizeMCPConformanceConfig({
      serverUrl,
      checkIds: [
        "server-accepts-multiple-post-streams",
        "modern-log-level-filtering",
      ],
      readinessIds: [],
    });
    expect(config.checkIds).toEqual(["modern-logs-require-log-level"]);
    expect(config.readinessIds).toEqual(["readiness-log-level-filtering"]);
  });

  it("keeps the removed id out of the checks that can run", () => {
    expect(MCP_CHECK_IDS).not.toContain("server-accepts-multiple-post-streams");
    expect(Object.keys(REMOVED_MCP_CHECK_IDS)).toEqual([
      "server-accepts-multiple-post-streams",
    ]);
  });

  it("runs a renamed Tasks check under its current name", () => {
    const config = normalizeMCPTasksConformanceConfig({
      url: serverUrl,
      checkIds: ["tasks-input-required-update-completes", "tasks-update-ack-shape"],
    });
    expect(config.checkIds).toEqual(["tasks-update-ack-shape"]);
  });
});

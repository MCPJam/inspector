import { describe, expect, it } from "vitest";
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

  it("runs a renamed Tasks check under its current name", () => {
    const config = normalizeMCPTasksConformanceConfig({
      url: serverUrl,
      checkIds: ["tasks-input-required-update-completes", "tasks-update-ack-shape"],
    });
    expect(config.checkIds).toEqual(["tasks-update-ack-shape"]);
  });
});

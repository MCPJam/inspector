import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkConformanceConnectionMock } = vi.hoisted(() => ({
  checkConformanceConnectionMock: vi.fn(),
}));

vi.mock("../../routes/shared/conformance-connection.js", () => ({
  checkConformanceConnection: (...args: unknown[]) =>
    checkConformanceConnectionMock(...args),
}));

import { MCP_TASKS_CHECK_IDS } from "@mcpjam/sdk";
import {
  readConformanceRunSettings,
  suiteConfigsForRun,
  suitesKeptBySettings,
  type ConformanceRunSettings,
} from "../conformance-run-settings.js";

const IDS = { projectId: "p1", serverId: "s1" };

function convexReturning(row: unknown) {
  return { query: vi.fn(async () => row) };
}

const SAVED_ROW = {
  serverId: "s1",
  defaultChecks: {
    protocol: ["tools-list", "modern-tool-output-schema-conformant"],
    apps: [],
  },
  defaultAdvice: { protocolAdvice: [] },
  defaultInputs: {
    toolCallProbe: { toolName: "echo", arguments: '{"message":"hi"}' },
  },
  runTimeoutSeconds: 45,
  updatedAt: 1,
};

describe("readConformanceRunSettings", () => {
  it("reads nothing when the caller opts out", async () => {
    const client = convexReturning(SAVED_ROW);
    const settings = await readConformanceRunSettings(client, {
      ...IDS,
      mode: "none",
    });
    expect(settings).toEqual({
      source: "none",
      probes: {},
      runTimeoutSeconds: 300,
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("runs every check with no tool inputs for a server with nothing saved", async () => {
    const settings = await readConformanceRunSettings(convexReturning(null), {
      ...IDS,
      mode: "saved",
    });
    expect(settings).toEqual({
      source: "defaults",
      probes: {},
      runTimeoutSeconds: 300,
    });
  });

  it("decodes the saved row the way the app does", async () => {
    const client = convexReturning(SAVED_ROW);
    const settings = await readConformanceRunSettings(client, {
      ...IDS,
      mode: "saved",
    });
    expect(client.query).toHaveBeenCalledWith(
      "conformanceSettings:getServerSettings",
      IDS,
    );
    expect(settings).toMatchObject({
      source: "saved",
      selection: {
        protocol: ["tools-list", "modern-tool-output-schema-conformant"],
        apps: [],
        protocolAdvice: [],
      },
      probes: {
        toolCallProbe: { toolName: "echo", arguments: { message: "hi" } },
      },
      runTimeoutSeconds: 45,
    });
  });

  it("refuses a start whose saved inputs cannot be read, and says how to proceed", async () => {
    const corrupt = {
      ...SAVED_ROW,
      defaultInputs: { toolCallProbe: { toolName: "echo", arguments: "[1]" } },
    };
    await expect(
      readConformanceRunSettings(convexReturning(corrupt), {
        ...IDS,
        mode: "saved",
      }),
    ).rejects.toMatchObject({ status: 409, message: /settings set to "none"/ });
  });
});

describe("suitesKeptBySettings", () => {
  it("keeps the requested suites the settings select, in request order", () => {
    const settings: ConformanceRunSettings = {
      source: "saved",
      selection: { apps: [], tasks: ["tasks-wire-resolvable"] },
      probes: {},
      runTimeoutSeconds: 300,
    };
    expect(
      suitesKeptBySettings(["tasks", "apps", "protocol"], settings, undefined),
    ).toEqual(["tasks", "protocol"]);
  });

  it("keeps every requested suite without saved settings", () => {
    expect(
      suitesKeptBySettings(
        ["protocol", "apps", "tasks"],
        { source: "defaults", probes: {}, runTimeoutSeconds: 300 },
        undefined,
      ),
    ).toEqual(["protocol", "apps", "tasks"]);
  });
});

describe("suiteConfigsForRun", () => {
  const SERVER = { url: "https://mcp.example.test/mcp" };
  const SAVED: ConformanceRunSettings = {
    source: "saved",
    selection: {
      protocol: ["tools-list", "modern-tool-output-schema-conformant"],
      protocolAdvice: [],
    },
    probes: {
      toolCallProbe: { toolName: "echo", arguments: { message: "hi" } },
    },
    runTimeoutSeconds: 300,
  };

  beforeEach(() => {
    checkConformanceConnectionMock.mockReset();
  });

  it("leaves a run without saved settings to the SDK, but for the update check", async () => {
    const configs = await suiteConfigsForRun(
      { source: "none", probes: {}, runTimeoutSeconds: 300 },
      SERVER,
      "2025-11-25",
      new AbortController().signal,
    );
    expect(configs).toEqual({
      protocolVersion: "2025-11-25",
      tasks: {
        checkIds: MCP_TASKS_CHECK_IDS.filter(
          (id) => id !== "tasks-update-ack-shape",
        ),
      },
    });
    expect(checkConformanceConnectionMock).not.toHaveBeenCalled();
  });

  it("resolves the version first, then builds each suite at it", async () => {
    checkConformanceConnectionMock.mockResolvedValue({
      status: "ready",
      protocolVersion: "2026-07-28",
    });
    const configs = await suiteConfigsForRun(
      SAVED,
      SERVER,
      "2026-07-28",
      new AbortController().signal,
    );
    expect(checkConformanceConnectionMock).toHaveBeenCalledWith(
      SERVER,
      "2026-07-28",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(configs.protocolVersion).toBe("2026-07-28");
    expect(configs.protocol).toMatchObject({
      readinessIds: [],
      fixtures: {
        toolCalls: [{ toolName: "echo", arguments: { message: "hi" } }],
      },
    });
  });

  it("keeps the requested version when the connection does not resolve one", async () => {
    checkConformanceConnectionMock.mockResolvedValue({
      status: "failed",
      message: "refused",
    });
    const configs = await suiteConfigsForRun(
      SAVED,
      SERVER,
      undefined,
      new AbortController().signal,
    );
    expect(configs.protocolVersion).toBeUndefined();
    // Unpinned, the 2026-07-28 output-schema check never calls its tool.
    expect(configs.protocol).not.toHaveProperty("fixtures");
  });
});

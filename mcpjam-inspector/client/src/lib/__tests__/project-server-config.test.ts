import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMcpProtocolVersionOverride,
  type ProjectServerConfigDto,
} from "../project-server-config";

const PROJECT_ID = "proj_1";
const SERVER_ID = "srv_new";

const dto = (
  overrides: Partial<ProjectServerConfigDto> = {},
): ProjectServerConfigDto => ({
  projectId: PROJECT_ID,
  serverIds: [],
  overrides: {},
  autoConnectMode: "selected",
  ...overrides,
});

describe("applyMcpProtocolVersionOverride", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("saves a pin for an un-enrolled server WITHOUT enrolling it", async () => {
    // The backend used to reject an override key outside `serverIds`, so
    // pinning a protocol version on a server that wasn't auto-connected
    // meant quietly enrolling it. Overrides are validated against the
    // project's live catalog now, so a pin is purely a configuration
    // change — which matters most on a project with auto-connect OFF,
    // where the old behaviour would have switched it back on for this
    // server.
    const setConfig = vi.fn().mockResolvedValue(undefined);
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: dto({ serverIds: ["srv_other"] }),
      next: "2026-07-28",
      setConfig,
    });
    expect(setConfig).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      input: {
        serverIds: ["srv_other"],
        overrides: {
          [SERVER_ID]: { mcpProtocolVersionOverride: "2026-07-28" },
        },
        autoConnectMode: "selected",
      },
    });
  });

  it("never turns auto-connect back on for a project that has it off", async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: dto({ serverIds: [], autoConnectMode: "none" }),
      next: "2026-07-28",
      setConfig,
    });
    expect(setConfig.mock.calls[0][0].input.serverIds).toEqual([]);
    expect(setConfig.mock.calls[0][0].input.autoConnectMode).toBe("none");
  });

  it("carries an all-mode project through unchanged", async () => {
    // Passing the mode explicitly matters here: classified from the array
    // alone, a project whose catalog happens to be partially listed would
    // be re-derived as 'selected' and stop enrolling new servers.
    const setConfig = vi.fn().mockResolvedValue(undefined);
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: dto({ serverIds: [SERVER_ID], autoConnectMode: "all" }),
      next: "2026-07-28",
      setConfig,
    });
    expect(setConfig.mock.calls[0][0].input.autoConnectMode).toBe("all");
  });

  it("treats a null DTO as the empty baseline (no row yet)", async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: null,
      next: "2025-11-25",
      setConfig,
    });
    // A null DTO is the genuine "no row yet" baseline. The mode is still
    // sent, defaulting to "all" — omitting it would make this a legacy
    // write, which the backend classifies from the array, and an empty
    // array reads as "none". Saving a pin would have turned the whole
    // project's auto-connect off.
    expect(setConfig).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      input: {
        serverIds: [],
        overrides: {
          [SERVER_ID]: { mcpProtocolVersionOverride: "2025-11-25" },
        },
        autoConnectMode: "all",
      },
    });
  });

  it("keeps a server's opt-out when its protocol pin is cleared", async () => {
    // Clearing the pin collapses the entry to just the opt-out flag. If
    // that did not count as content the entry would be deleted, silently
    // putting a server the user chose to skip back into auto-connect as a
    // side effect of an unrelated change.
    const setConfig = vi.fn().mockResolvedValue(undefined);
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: dto({
        serverIds: [SERVER_ID],
        overrides: {
          [SERVER_ID]: {
            autoConnectDisabled: true,
            mcpProtocolVersionOverride: "2026-07-28",
          },
        },
      }),
      next: undefined,
      setConfig,
    });

    expect(setConfig.mock.calls[0][0].input.overrides).toEqual({
      [SERVER_ID]: { autoConnectDisabled: true },
    });
  });

  it("preserves other servers' overrides verbatim", async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: dto({
        serverIds: ["srv_other", SERVER_ID],
        overrides: {
          srv_other: { requestTimeoutOverride: 5000 },
        },
      }),
      next: "2026-07-28",
      setConfig,
    });
    expect(setConfig.mock.calls[0][0].input.overrides).toEqual({
      srv_other: { requestTimeoutOverride: 5000 },
      [SERVER_ID]: { mcpProtocolVersionOverride: "2026-07-28" },
    });
    expect(setConfig.mock.calls[0][0].input.serverIds).toEqual([
      "srv_other",
      SERVER_ID,
    ]);
  });

  it("clearing the pin drops the empty entry and leaves enrollment alone", async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: dto({
        serverIds: ["srv_other"],
        overrides: {
          [SERVER_ID]: { mcpProtocolVersionOverride: "2026-07-28" },
        },
      }),
      next: undefined,
      setConfig,
    });
    // The entry collapses to nothing and is dropped (mirroring the
    // backend's `normalizeOverrideEntry`); the pool is untouched, because
    // the pin never enrolled anything in the first place.
    expect(setConfig.mock.calls[0][0].input).toEqual({
      serverIds: ["srv_other"],
      overrides: {},
      autoConnectMode: "selected",
    });
  });

  it("clearing the pin keeps an explicitly enrolled server enrolled", async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: dto({
        serverIds: [SERVER_ID],
        overrides: {
          [SERVER_ID]: { mcpProtocolVersionOverride: "2026-07-28" },
        },
      }),
      next: undefined,
      setConfig,
    });
    expect(setConfig.mock.calls[0][0].input).toEqual({
      serverIds: [SERVER_ID],
      overrides: {},
      autoConnectMode: "selected",
    });
  });

  it("keeps the entry when other overrides remain after clearing the pin", async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: dto({
        serverIds: [SERVER_ID],
        overrides: {
          [SERVER_ID]: {
            requestTimeoutOverride: 8000,
            mcpProtocolVersionOverride: "2026-07-28",
          },
        },
      }),
      next: undefined,
      setConfig,
    });
    expect(setConfig.mock.calls[0][0].input.overrides).toEqual({
      [SERVER_ID]: { requestTimeoutOverride: 8000 },
    });
    expect(setConfig.mock.calls[0][0].input.serverIds).toEqual([SERVER_ID]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMcpProtocolVersionOverride,
  getProtocolOverrideAutoEnrollKey,
  readProtocolOverrideAutoEnrollRecord,
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
  ...overrides,
});

describe("applyMcpProtocolVersionOverride", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("enrolls an un-enrolled server and records provenance (add-flow shape)", async () => {
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
        serverIds: ["srv_other", SERVER_ID],
        overrides: {
          [SERVER_ID]: { mcpProtocolVersionOverride: "2026-07-28" },
        },
      },
    });
    expect(
      readProtocolOverrideAutoEnrollRecord(
        getProtocolOverrideAutoEnrollKey(PROJECT_ID, SERVER_ID),
      ),
    ).toEqual({ previousServerIds: ["srv_other"] });
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
    expect(setConfig).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      input: {
        serverIds: [SERVER_ID],
        overrides: {
          [SERVER_ID]: { mcpProtocolVersionOverride: "2025-11-25" },
        },
      },
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

  it("clearing the pin drops the empty entry and undoes an implicit enrollment", async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
    // First: implicit enrollment via pin.
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: dto({ serverIds: ["srv_other"] }),
      next: "2026-07-28",
      setConfig,
    });
    // Then: clear it against the post-write state.
    await applyMcpProtocolVersionOverride({
      projectId: PROJECT_ID,
      serverId: SERVER_ID,
      current: dto({
        serverIds: ["srv_other", SERVER_ID],
        overrides: {
          [SERVER_ID]: { mcpProtocolVersionOverride: "2026-07-28" },
        },
      }),
      next: undefined,
      setConfig,
    });
    expect(setConfig.mock.calls[1][0].input).toEqual({
      serverIds: ["srv_other"],
      overrides: {},
    });
    expect(
      readProtocolOverrideAutoEnrollRecord(
        getProtocolOverrideAutoEnrollKey(PROJECT_ID, SERVER_ID),
      ),
    ).toBeUndefined();
  });

  it("clearing the pin keeps an explicitly enrolled server enrolled", async () => {
    const setConfig = vi.fn().mockResolvedValue(undefined);
    // No provenance record exists — the server was enrolled by the user.
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

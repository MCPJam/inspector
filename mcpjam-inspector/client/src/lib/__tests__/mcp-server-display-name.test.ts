import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getMcpServerDisplayName,
  formatMcpServerRefsForError,
} from "../mcp-server-display-name";
import { setHostedApiContext } from "../apis/web/context";

vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return mockHosted;
  },
}));

let mockHosted = false;

describe("getMcpServerDisplayName", () => {
  beforeEach(() => {
    mockHosted = false;
    setHostedApiContext({
      workspaceId: "ws-1",
      isAuthenticated: true,
      serverIdsByName: { asana: "id-asana" },
    });
  });

  it("resolves a Convex _id to the workspace server name", () => {
    expect(
      getMcpServerDisplayName("k1234567890123456789012345", {
        remoteServers: [
          {
            _id: "k1234567890123456789012345",
            workspaceId: "ws-1",
            name: "My Tools",
            enabled: true,
            transportType: "http" as const,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    ).toBe("My Tools");
  });

  it("uses hosted mapping when the ref is a server id", () => {
    mockHosted = true;
    expect(
      getMcpServerDisplayName("id-asana", { remoteServers: [] }),
    ).toBe("asana");
  });

  it("hides unresolvable opaque ids", () => {
    expect(
      getMcpServerDisplayName("mn79gdfjnftd2esny26j8n4w0s83hc8n", {
        remoteServers: [],
      }),
    ).toBe("A server that is no longer in this workspace");
  });

  it("passes through readable names", () => {
    expect(
      getMcpServerDisplayName("playground", { remoteServers: [] }),
    ).toBe("playground");
  });
});

describe("formatMcpServerRefsForError", () => {
  it("dedupes identical display labels", () => {
    expect(
      formatMcpServerRefsForError(
        ["a11111111111111111111111111111", "a22222222222222222222222222222"],
        { remoteServers: [] },
      ),
    ).toBe("A server that is no longer in this workspace");
  });
});

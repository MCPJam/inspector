import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getMcpServerDisplayName,
  formatMcpServerRefsForError,
  formatMcpConnectServerPrompt,
  isUnresolvableMcpServerRef,
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

  it("hides unresolvable opaque ids with a short list label", () => {
    expect(
      getMcpServerDisplayName("mn79gdfjnftd2esny26j8n4w0s83hc8n", {
        remoteServers: [],
      }),
    ).toBe("a removed server");
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
    ).toBe("a removed server");
  });
});

describe("isUnresolvableMcpServerRef", () => {
  it("is true for opaque ids with no workspace or hosted match", () => {
    mockHosted = false;
    expect(
      isUnresolvableMcpServerRef("mn79gdfjnftd2esny26j8n4w0s83hc8n", {
        remoteServers: [],
      }),
    ).toBe(true);
  });

  it("is false when the id exists in remote servers", () => {
    expect(
      isUnresolvableMcpServerRef("kid", {
        remoteServers: [
          {
            _id: "kid",
            workspaceId: "w",
            name: "Known",
            enabled: true,
            transportType: "http" as const,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("formatMcpConnectServerPrompt", () => {
  it("uses plain language when every ref is unresolvable", () => {
    expect(
      formatMcpConnectServerPrompt(
        ["mn79gdfjnftd2esny26j8n4w0s83hc8n"],
        { remoteServers: [], kind: "test-case" },
      ),
    ).toBe(
      "Add or reconnect the MCP server this test needs, then run it.",
    );
  });

  it("keeps the Connect … phrasing when names are known", () => {
    expect(
      formatMcpConnectServerPrompt(["asana"], {
        remoteServers: [],
        kind: "suite",
      }),
    ).toBe("Connect to asana to run this suite.");
  });
});

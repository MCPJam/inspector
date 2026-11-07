import { describe, expect, it } from "vitest";
import {
  mergeMcpToolConnectionMetadata,
  readMcpToolConnectionId,
  toolConnectionAttribution,
} from "../mcp-tool-origin-metadata";

const explicit = {
  serverId: "server-1",
  connectionId: "account-b",
  label: "Work",
};

describe("tool-call connection metadata", () => {
  it("stamps an account the call was routed to", () => {
    const metadata = mergeMcpToolConnectionMetadata(undefined, explicit);
    expect(readMcpToolConnectionId(metadata)).toBe("account-b");
  });

  it("keeps a server's only login off the call (Run stays enabled)", () => {
    const implicit = { ...explicit, implicit: true as const };
    expect(mergeMcpToolConnectionMetadata(undefined, implicit)).toBeUndefined();
    const base = { mcpjam: { serverId: "server-1" } };
    expect(mergeMcpToolConnectionMetadata(base, implicit)).toEqual(base);
  });

  it("still attributes an implicit login server-side", () => {
    const tool = {
      _connectionForInput: () => ({
        serverId: "server-1",
        connectionId: "only",
        label: "Lazy bench",
        implicit: true,
      }),
    };
    expect(toolConnectionAttribution(tool, {})).toEqual({
      serverId: "server-1",
      connectionId: "only",
      label: "Lazy bench",
      implicit: true,
    });
  });

  it("attributes an explicit account without the flag", () => {
    const tool = { _connectionForCall: () => ({ ...explicit }) };
    expect(toolConnectionAttribution(tool, {}, "call-1")).toEqual(explicit);
  });
});

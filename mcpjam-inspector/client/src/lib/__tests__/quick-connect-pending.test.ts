import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingQuickConnect,
  readPendingQuickConnect,
  writePendingQuickConnect,
} from "../quick-connect-pending";

describe("quick-connect-pending", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("writes and reads structured pending quick-connect state", () => {
    writePendingQuickConnect({
      serverName: "Linear",
      registryServerId: "linear-1",
      displayName: "Linear",
      sourceTab: "servers",
      createdAt: 123,
    });

    expect(readPendingQuickConnect()).toEqual({
      serverName: "Linear",
      registryServerId: "linear-1",
      displayName: "Linear",
      sourceTab: "servers",
      createdAt: 123,
    });
  });

  it("falls back from the legacy registry pending redirect key", () => {
    localStorage.setItem("registry-pending-redirect", "Linear");

    expect(readPendingQuickConnect()).toEqual({
      serverName: "Linear",
      displayName: "Linear",
      sourceTab: "registry",
      createdAt: expect.any(Number),
    });
  });

  it("returns null for malformed structured state", () => {
    localStorage.setItem("mcp-quick-connect-pending", "{not-json");

    expect(readPendingQuickConnect()).toBeNull();
  });

  it("clears both structured and legacy state", () => {
    writePendingQuickConnect({
      serverName: "Linear",
      registryServerId: "linear-1",
      displayName: "Linear",
      sourceTab: "registry",
      createdAt: 123,
    });
    localStorage.setItem("registry-pending-redirect", "Linear");

    clearPendingQuickConnect();

    expect(localStorage.getItem("mcp-quick-connect-pending")).toBeNull();
    expect(localStorage.getItem("registry-pending-redirect")).toBeNull();
    expect(readPendingQuickConnect()).toBeNull();
  });
});

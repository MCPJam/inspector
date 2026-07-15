import { describe, it, expect, beforeEach } from "vitest";
import {
  recordTunnelRequest,
  getTunnelRequests,
  clearTunnelRequests,
} from "../tunnel-request-log.js";

describe("tunnel-request-log", () => {
  const serverId = "log-test-server";

  beforeEach(() => {
    clearTunnelRequests(serverId);
  });

  it("returns entries newest-first", () => {
    recordTunnelRequest(serverId, { method: "initialize", path: "/a" });
    recordTunnelRequest(serverId, { method: "tools/list", path: "/b" });

    const entries = getTunnelRequests(serverId);
    expect(entries).toHaveLength(2);
    expect(entries[0].method).toBe("tools/list");
    expect(entries[1].method).toBe("initialize");
  });

  it("labels method-less frames as notifications", () => {
    recordTunnelRequest(serverId, { path: "/x" });
    expect(getTunnelRequests(serverId)[0].method).toBe("(notification)");
  });

  it("caps the buffer per server", () => {
    for (let i = 0; i < 75; i++) {
      recordTunnelRequest(serverId, { method: `m${i}`, path: "/p" });
    }
    const entries = getTunnelRequests(serverId);
    expect(entries).toHaveLength(50);
    expect(entries[0].method).toBe("m74");
  });

  it("isolates buffers per server and clears them", () => {
    recordTunnelRequest(serverId, { method: "a", path: "/" });
    recordTunnelRequest("other-server", { method: "b", path: "/" });

    expect(getTunnelRequests(serverId)).toHaveLength(1);
    clearTunnelRequests(serverId);
    expect(getTunnelRequests(serverId)).toHaveLength(0);
    expect(getTunnelRequests("other-server")).toHaveLength(1);
    clearTunnelRequests("other-server");
  });
});

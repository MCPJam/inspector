import { describe, it, expect, beforeEach } from "vitest";
import {
  writeInspectionDetailRequest,
  readInspectionDetailRequest,
  clearInspectionDetailRequest,
} from "@/lib/inspection-detail-request";

describe("inspection-detail-request", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("write/read lifecycle works", () => {
    writeInspectionDetailRequest("my-server");
    const request = readInspectionDetailRequest();
    expect(request).not.toBeNull();
    expect(request!.serverName).toBe("my-server");
    expect(typeof request!.createdAt).toBe("number");
  });

  it("read returns null when nothing written", () => {
    expect(readInspectionDetailRequest()).toBeNull();
  });

  it("clear removes the request", () => {
    writeInspectionDetailRequest("my-server");
    clearInspectionDetailRequest();
    expect(readInspectionDetailRequest()).toBeNull();
  });

  it("returns null for stale requests (> 5 min TTL)", () => {
    writeInspectionDetailRequest("my-server");
    // Manually set createdAt to 6 minutes ago
    const raw = localStorage.getItem("mcp-inspection-detail-request");
    const parsed = JSON.parse(raw!);
    parsed.createdAt = Date.now() - 6 * 60 * 1000;
    localStorage.setItem(
      "mcp-inspection-detail-request",
      JSON.stringify(parsed),
    );

    expect(readInspectionDetailRequest()).toBeNull();
    // Stale entry should be auto-cleared
    expect(localStorage.getItem("mcp-inspection-detail-request")).toBeNull();
  });

  it("returns null and clears invalid JSON", () => {
    localStorage.setItem("mcp-inspection-detail-request", "not-json");
    expect(readInspectionDetailRequest()).toBeNull();
    expect(localStorage.getItem("mcp-inspection-detail-request")).toBeNull();
  });

  it("returns null and clears malformed data", () => {
    localStorage.setItem(
      "mcp-inspection-detail-request",
      JSON.stringify({ wrong: "shape" }),
    );
    expect(readInspectionDetailRequest()).toBeNull();
    expect(localStorage.getItem("mcp-inspection-detail-request")).toBeNull();
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";

// Hosted build: every suite that has a `/api/web/conformance/*` route must
// route there rather than falling back to (or refusing) the local endpoint.
vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/apis/web/context", () => ({
  buildServerRequest: vi.fn(() => ({
    projectId: "ws-1",
    serverId: "srv-1",
  })),
}));

vi.mock("@/lib/apis/web/base", () => ({
  webPost: vi.fn(() => Promise.resolve({ success: true, result: {} })),
}));

import { webPost } from "@/lib/apis/web/base";
import { runTasksConformance } from "../mcp-conformance-api";

beforeEach(() => {
  vi.mocked(webPost).mockClear();
});

describe("runTasksConformance (hosted)", () => {
  it("posts to the hosted tasks route with the resolved server request", async () => {
    await runTasksConformance("tasks-server");

    expect(webPost).toHaveBeenCalledWith("/api/web/conformance/tasks", {
      projectId: "ws-1",
      serverId: "srv-1",
    });
  });

  it("forwards the probe tool options", async () => {
    await runTasksConformance("tasks-server", {
      toolName: "long_job",
      toolArguments: { seconds: 5 },
    });

    expect(webPost).toHaveBeenCalledWith("/api/web/conformance/tasks", {
      projectId: "ws-1",
      serverId: "srv-1",
      toolName: "long_job",
      toolArguments: { seconds: 5 },
    });
  });
});

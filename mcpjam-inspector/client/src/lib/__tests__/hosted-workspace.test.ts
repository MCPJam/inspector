import { describe, expect, it } from "vitest";

import { resolveHostedWorkspaceId } from "../hosted-workspace";

describe("resolveHostedWorkspaceId", () => {
  it("keeps the workspace id for authenticated users", () => {
    expect(resolveHostedWorkspaceId(true, "ws_123")).toBe("ws_123");
  });

  it("drops stale workspace ids for signed-out users", () => {
    expect(resolveHostedWorkspaceId(false, "ws_stale")).toBeNull();
  });

  it("returns null when no workspace id exists", () => {
    expect(resolveHostedWorkspaceId(true, null)).toBeNull();
  });
});

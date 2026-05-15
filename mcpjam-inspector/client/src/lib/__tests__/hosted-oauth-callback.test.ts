import { beforeEach, describe, expect, it } from "vitest";
import {
  readHostedOAuthPendingMarker,
  resolveHostedOAuthReturnPath,
  writeHostedOAuthPendingMarker,
} from "../hosted-oauth-callback";

describe("hosted OAuth return paths", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("preserves chatbox slug return paths", () => {
    writeHostedOAuthPendingMarker({
      surface: "chatbox",
      serverName: "Asana",
      serverUrl: "https://example.com/mcp",
      returnHash: "/asana",
    });

    expect(readHostedOAuthPendingMarker()?.returnHash).toBe("/asana");
    expect(
      resolveHostedOAuthReturnPath({
        surface: "chatbox",
        returnHash: "/asana",
      }),
    ).toBe("/asana");
  });

  it("accepts legacy chatbox hash return targets", () => {
    expect(
      resolveHostedOAuthReturnPath({
        surface: "chatbox",
        returnHash: "#asana",
      }),
    ).toBe("/asana");
  });

  it("keeps project return targets on known app routes", () => {
    expect(
      resolveHostedOAuthReturnPath({
        surface: "project",
        returnHash: "#/evals",
      }),
    ).toBe("/evals");
    expect(
      resolveHostedOAuthReturnPath({
        surface: "project",
        returnHash: "/not-an-app-route",
      }),
    ).toBe("/servers");
  });
});

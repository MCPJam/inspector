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
      returnPath: "/asana",
    });

    expect(readHostedOAuthPendingMarker()?.returnPath).toBe("/asana");
    expect(
      resolveHostedOAuthReturnPath({
        surface: "chatbox",
        returnPath: "/asana",
      }),
    ).toBe("/asana");
  });

  it("accepts legacy chatbox hash return targets", () => {
    expect(
      resolveHostedOAuthReturnPath({
        surface: "chatbox",
        returnPath: "#asana",
      }),
    ).toBe("/asana");
  });

  it("keeps project return targets on known app routes", () => {
    expect(
      resolveHostedOAuthReturnPath({
        surface: "project",
        returnPath: "#/evals",
      }),
    ).toBe("/evals");
    expect(
      resolveHostedOAuthReturnPath({
        surface: "project",
        returnPath: "/not-an-app-route",
      }),
    ).toBe("/servers");
  });

  it("reads in-flight pending markers that still use the old returnHash field", () => {
    localStorage.setItem(
      "mcp-hosted-oauth-pending",
      JSON.stringify({
        surface: "project",
        serverName: "Asana",
        serverUrl: "https://example.com/mcp",
        returnHash: "#/evals",
        startedAt: Date.now(),
      }),
    );

    expect(readHostedOAuthPendingMarker()?.returnPath).toBe("/evals");
  });
});

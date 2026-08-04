import { beforeEach, describe, expect, it } from "vitest";
import {
  clearHostedOAuthPendingMarker,
  readHostedOAuthPendingMarker,
  resolveHostedOAuthReturnPath,
  writeHostedOAuthPendingMarker,
} from "../hosted-oauth-callback";
import {
  clearHostedOAuthResumeMarker,
  isHostedOAuthSurface,
  readHostedOAuthResumeMarker,
  writeHostedOAuthResumeMarker,
} from "../hosted-oauth-resume";

/**
 * The whole reason `"score"` exists as its own surface: neither of the other
 * two can carry a score run through an OAuth redirect. "project" rewrites the
 * return path to `/servers` (the segment is not an app tab), and "chatbox"
 * expects a chatbox id there is none of.
 */

beforeEach(() => {
  clearHostedOAuthPendingMarker();
  clearHostedOAuthResumeMarker();
});

describe("score OAuth surface", () => {
  it("is a recognized surface", () => {
    expect(isHostedOAuthSurface("score")).toBe(true);
    expect(isHostedOAuthSurface("project")).toBe(true);
    expect(isHostedOAuthSurface("chatbox")).toBe(true);
    expect(isHostedOAuthSurface("nope")).toBe(false);
  });

  it("round-trips a pending marker without collapsing /embed/score", () => {
    writeHostedOAuthPendingMarker({
      surface: "score",
      serverName: "mcp.example.com",
      serverUrl: "https://mcp.example.com/mcp",
      projectId: "p1",
      serverId: "s1",
      returnPath: "/embed/score",
    });

    const marker = readHostedOAuthPendingMarker();
    expect(marker?.surface).toBe("score");
    expect(marker?.returnPath).toBe("/embed/score");
  });

  it("collapses the SAME path to /servers under the project surface", () => {
    // The bug this surface exists to avoid, pinned so it cannot come back.
    writeHostedOAuthPendingMarker({
      surface: "project",
      serverName: "mcp.example.com",
      serverUrl: "https://mcp.example.com/mcp",
      projectId: "p1",
      serverId: "s1",
      returnPath: "/embed/score",
    });

    expect(readHostedOAuthPendingMarker()?.returnPath).toBe("/servers");
  });

  it("returns the visitor to the runner, not to /servers", () => {
    expect(
      resolveHostedOAuthReturnPath({
        surface: "score",
        returnPath: "/embed/score",
      })
    ).toBe("/embed/score");
  });

  it("falls back to the runner when the return path went missing", () => {
    expect(
      resolveHostedOAuthReturnPath({ surface: "score", returnPath: null })
    ).toBe("/embed/score");
  });

  it("still refuses a protocol-relative return path", () => {
    // The carve-out is same-origin absolute paths only — never an escape
    // hatch to another host.
    writeHostedOAuthPendingMarker({
      surface: "score",
      serverName: "mcp.example.com",
      serverUrl: "https://mcp.example.com/mcp",
      projectId: "p1",
      serverId: "s1",
      returnPath: "//evil.example.com/steal",
    });

    expect(readHostedOAuthPendingMarker()?.returnPath).not.toContain(
      "evil.example.com"
    );
  });

  it("round-trips a resume marker on the score surface", () => {
    writeHostedOAuthResumeMarker({
      surface: "score",
      serverName: "mcp.example.com",
      serverUrl: "https://mcp.example.com/mcp",
    });

    expect(readHostedOAuthResumeMarker("score")?.serverName).toBe(
      "mcp.example.com"
    );
    // Surface filtering still discriminates.
    expect(readHostedOAuthResumeMarker("project")).toBeNull();
  });
});

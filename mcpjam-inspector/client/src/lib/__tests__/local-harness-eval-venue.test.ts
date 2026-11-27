import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-token", () => ({ authFetch }));

import { fetchLocalHarnessEvalVenue } from "../local-harness-eval-venue";
import { launchReasonOf, suiteOnMcpjamUrl, withLaunchReason } from "../eval-launch-reason";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => authFetch.mockReset());

describe("asking where an eval runs", () => {
  it("asks for the harness and project, with the app's own sign-in", async () => {
    authFetch.mockResolvedValue(json(200, { venue: "local" }));
    await expect(fetchLocalHarnessEvalVenue("codex", "project 1")).resolves.toEqual({ ok: true, venue: { venue: "local" } });
    expect(authFetch).toHaveBeenCalledWith(
      "/api/mcp/local-harness/eval-venue?projectId=project%201&harnessId=codex",
      { signal: undefined },
    );
  });

  it("reads a refusal with its reason and fix", async () => {
    const venue = { venue: "refused", refusal: "not-set-up", message: "m", fix: "set-up" };
    authFetch.mockResolvedValue(json(200, venue));
    await expect(fetchLocalHarnessEvalVenue("claude-code", "p")).resolves.toEqual({ ok: true, venue });
  });

  it("says when this Inspector serves no local clients, and when the answer was unreadable", async () => {
    authFetch.mockResolvedValueOnce(json(404, { error: "Not found" }));
    await expect(fetchLocalHarnessEvalVenue("claude-code", "p")).resolves.toEqual({ ok: false, turnedOff: true });
    authFetch.mockResolvedValueOnce(json(500, { error: "boom" }));
    await expect(fetchLocalHarnessEvalVenue("claude-code", "p")).resolves.toEqual({ ok: false, turnedOff: false });
    authFetch.mockResolvedValueOnce(json(200, { venue: "refused", fix: "reboot" }));
    await expect(fetchLocalHarnessEvalVenue("claude-code", "p")).resolves.toEqual({ ok: false, turnedOff: false });
    authFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchLocalHarnessEvalVenue("claude-code", "p")).resolves.toEqual({ ok: false, turnedOff: false });
  });
});

describe("a launch refusal's reason", () => {
  it("survives the rethrow that rewords the message", () => {
    const refused = Object.assign(new Error("raw"), { reason: "EVAL_CODE_EVALUATORS_UNAVAILABLE" });
    expect(launchReasonOf(withLaunchReason(new Error("Reworded."), refused))).toBe("EVAL_CODE_EVALUATORS_UNAVAILABLE");
    expect(launchReasonOf(withLaunchReason(new Error("Reworded."), new Error("plain")))).toBeUndefined();
  });

  it("links to the suite on MCPJam, opened to its run review", () => {
    expect(suiteOnMcpjamUrl("suite_1")).toBe("https://app.mcpjam.com/evaluate?run=suite_1");
  });
});

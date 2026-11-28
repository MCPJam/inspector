import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-token", () => ({ authFetch }));

import { fetchLocalHarnessEvalVenue } from "../local-harness-eval-venue";
import { launchReasonOf, runsOnMcpjamInstead, suiteOnMcpjamUrl, withLaunchReason } from "../eval-launch-reason";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => authFetch.mockReset());
afterEach(() => vi.useRealTimers());

describe("asking where an eval runs", () => {
  it("asks for the harness and project, with the app's own sign-in", async () => {
    authFetch.mockResolvedValue(json(200, { venue: "local" }));
    await expect(fetchLocalHarnessEvalVenue("codex", "project 1")).resolves.toEqual({ ok: true, venue: { venue: "local" } });
    expect(authFetch).toHaveBeenCalledWith(
      "/api/mcp/local-harness/eval-venue?projectId=project%201&harnessId=codex",
      { signal: expect.any(AbortSignal) },
    );
  });

  it("reads a refusal with its reason and fix", async () => {
    const venue = { venue: "refused", refusal: "not-set-up", message: "m", fix: "set-up" };
    authFetch.mockResolvedValue(json(200, venue));
    await expect(fetchLocalHarnessEvalVenue("claude-code", "p")).resolves.toEqual({ ok: true, venue });
  });

  it("says when this Inspector serves no local clients, and keeps the status of a failed check", async () => {
    authFetch.mockResolvedValueOnce(json(404, { error: "Not found" }));
    await expect(fetchLocalHarnessEvalVenue("claude-code", "p")).resolves.toEqual({ ok: false, turnedOff: true, status: 404 });
    authFetch.mockResolvedValueOnce(json(401, { error: "Unauthorized" }));
    await expect(fetchLocalHarnessEvalVenue("claude-code", "p")).resolves.toEqual({ ok: false, turnedOff: false, status: 401 });
    authFetch.mockResolvedValueOnce(json(200, { venue: "refused", fix: "reboot" }));
    await expect(fetchLocalHarnessEvalVenue("claude-code", "p")).resolves.toEqual({ ok: false, turnedOff: false, status: 200 });
    authFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchLocalHarnessEvalVenue("claude-code", "p")).resolves.toEqual({ ok: false, turnedOff: false });
  });

  it("gives up on a check that never answers, so the sheet can offer Retry", async () => {
    vi.useFakeTimers();
    // Only the venue check hangs; anything else the app asks for meanwhile answers.
    authFetch.mockImplementation((url?: unknown, init?: { signal?: AbortSignal }) =>
      typeof url === "string" && url.includes("eval-venue")
        ? new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
        : Promise.resolve(json(200, {})),
    );
    const answer = fetchLocalHarnessEvalVenue("claude-code", "p");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(answer).resolves.toEqual({ ok: false, turnedOff: false });
  });

  it("gives up on a check whose headers arrive but whose body never finishes", async () => {
    vi.useFakeTimers();
    authFetch.mockImplementation((_url?: unknown, init?: { signal?: AbortSignal }) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      }),
    );
    const answer = fetchLocalHarnessEvalVenue("claude-code", "p");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(answer).resolves.toEqual({ ok: false, turnedOff: false });
  });
});

describe("a launch refusal's reason", () => {
  it("survives the rethrow that rewords the message", () => {
    const refused = Object.assign(new Error("raw"), { reason: "EVAL_CODE_EVALUATORS_UNAVAILABLE", rule: "local_run" });
    expect(launchReasonOf(withLaunchReason(new Error("Reworded."), refused))).toEqual({
      reason: "EVAL_CODE_EVALUATORS_UNAVAILABLE",
      rule: "local_run",
    });
    expect(launchReasonOf(withLaunchReason(new Error("Reworded."), new Error("plain")))).toEqual({});
  });

  it("sends only the refusals MCPJam's own runners lift to MCPJam", () => {
    const refusal = (rule: string) => Object.assign(new Error("m"), { reason: "EVAL_CODE_EVALUATORS_UNAVAILABLE", rule });
    expect(runsOnMcpjamInstead(refusal("local_run"))).toBe(true);
    expect(runsOnMcpjamInstead(refusal("runner_without_sandboxes"))).toBe(true);
    expect(runsOnMcpjamInstead(refusal("grading_not_enforce"))).toBe(false);
    expect(runsOnMcpjamInstead(refusal("grading_off"))).toBe(false);
    expect(runsOnMcpjamInstead(new Error("m"))).toBe(false);
  });

  it("links to the suite on MCPJam, opened to its run review", () => {
    expect(suiteOnMcpjamUrl("suite_1")).toBe("https://app.mcpjam.com/evaluate?run=suite_1");
  });
});

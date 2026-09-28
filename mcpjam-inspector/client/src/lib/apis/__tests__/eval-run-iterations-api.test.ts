/**
 * The iterations read, and the two things it must not do.
 *
 * It exists to cover the population D9's diagnostics exclude by contract — the
 * trials that PASSED — so the assertions concentrate on the places where a
 * convenient shortcut would produce a chain nobody may believe:
 *
 *   - validating rows one at a time instead of the whole derivation, which
 *     admits five rows or six out of order and turns a positional claim
 *     (`notReached`) into a false one;
 *   - reading an undeployed route as a run with no chains.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.fn();
vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetch(...args),
}));

import {
  fetchEvalRunIterationChains,
  isEvalRunIterationsError,
} from "../eval-run-iterations-api";
import { USER_VALUE_STAGES } from "@mcpjam/sdk/contract";

function rows(overrides: Record<string, string> = {}) {
  return USER_VALUE_STAGES.map((stage) => ({
    stage,
    state: overrides[stage] ?? "passed",
    reason: "observed",
  }));
}

function iteration(extra: Record<string, unknown> = {}) {
  return {
    id: "iter_1",
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    stageResults: rows(),
    stageAnalyzerVersion: 8,
    ...extra,
  };
}

function respondWith(body: unknown, status = 200) {
  authFetch.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  authFetch.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("fetchEvalRunIterationChains", () => {
  it("returns a verified chain for a PASSING trial — the population D9 omits", async () => {
    respondWith({ items: [iteration()] });

    const page = await fetchEvalRunIterationChains({
      projectId: "proj_1",
      runId: "run_1",
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.iterationId).toBe("iter_1");
    expect(page.items[0]?.chain.status).toBe("verified");
  });

  it("reads the run-scoped iterations path, and lets authFetch own the bearer", async () => {
    respondWith({ items: [] });
    await fetchEvalRunIterationChains({ projectId: "proj_1", runId: "run_1" });

    const url = String(authFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/api/v1/projects/proj_1/eval-runs/run_1/iterations");
    // The client's own Authorization is stripped before the shim runs, so the
    // header has exactly one owner.
    const headers = new Headers(
      (authFetch.mock.calls[0]?.[1] as RequestInit)?.headers,
    );
    expect(headers.get("authorization")).toBeNull();
  });

  it("REFUSES a derivation that is not six rows in chain order", async () => {
    // Row-level validation would accept both of these. The whole-derivation
    // parse is what makes a positional claim safe to render as card 01..06.
    respondWith({
      items: [iteration({ stageResults: rows().slice(0, 5) })],
    });
    const short = await fetchEvalRunIterationChains({
      projectId: "proj_1",
      runId: "run_1",
    });
    expect(short.items[0]?.chain.status).toBe("unverified");

    respondWith({
      items: [iteration({ stageResults: [...rows()].reverse() })],
    });
    const reordered = await fetchEvalRunIterationChains({
      projectId: "proj_1",
      runId: "run_1",
    });
    expect(reordered.items[0]?.chain.status).toBe("unverified");
  });

  it("carries the server's own quarantine through as unverified", async () => {
    respondWith({
      items: [
        iteration({ stageResults: undefined, stageResultsUnverified: true }),
      ],
    });
    const page = await fetchEvalRunIterationChains({
      projectId: "proj_1",
      runId: "run_1",
    });
    expect(page.items[0]?.chain.status).toBe("unverified");
  });

  it("says absent when no derivation was ever offered", async () => {
    respondWith({ items: [iteration({ stageResults: undefined })] });
    const page = await fetchEvalRunIterationChains({
      projectId: "proj_1",
      runId: "run_1",
    });
    expect(page.items[0]?.chain.status).toBe("absent");
  });

  it("separates an undeployed route from a run that is not there", async () => {
    // A bare 404 from a router that never had this path…
    authFetch.mockResolvedValue(new Response("Not Found", { status: 404 }));
    await expect(
      fetchEvalRunIterationChains({ projectId: "proj_1", runId: "run_1" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isEvalRunIterationsError(error) && error.kind === "routeUnavailable",
    );

    // …versus the route's own answer about a run.
    respondWith({ code: "NOT_FOUND", message: "Eval run not found" }, 404);
    await expect(
      fetchEvalRunIterationChains({ projectId: "proj_1", runId: "run_1" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isEvalRunIterationsError(error) && error.kind === "notFound",
    );
  });

  it("rejects a row with no iteration id rather than joining it to the wrong trial", async () => {
    respondWith({ items: [iteration({ id: undefined })] });
    await expect(
      fetchEvalRunIterationChains({ projectId: "proj_1", runId: "run_1" }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isEvalRunIterationsError(error) && error.kind === "invalidContract",
    );
  });

  it("passes the page cursor through and hands the next one back", async () => {
    respondWith({ items: [iteration()], nextCursor: "cursor_2" });
    const page = await fetchEvalRunIterationChains({
      projectId: "proj_1",
      runId: "run_1",
      cursor: "cursor_1",
      limit: 50,
    });
    expect(String(authFetch.mock.calls[0]?.[0])).toContain("cursor=cursor_1");
    expect(page.nextCursor).toBe("cursor_2");
  });
});

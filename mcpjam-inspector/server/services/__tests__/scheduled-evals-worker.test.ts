import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import catalog from "../../../shared/telemetry-catalog.generated.json";
import {
  claimNextForTests,
  classifyFailure,
  startScheduledEvalsWorker,
} from "../scheduled-evals-worker";
import { logger } from "../../utils/logger";

const CLAIM = {
  triggerId: "trig-1",
  suiteId: "suite-1",
  suiteName: "Monitored Suite",
  organizationId: "org-1",
  projectId: "proj-1",
  createdByExternalId: "user_workos_1",
  scheduledFor: 1700000000000,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("scheduled-evals claim", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts the worker's claimedBy to the scheduled-eval claim route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true, claimed: CLAIM }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(claimNextForTests("inspector-7")).resolves.toEqual(CLAIM);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://convex.test/internal/v1/scheduled-eval-runs/claim",
    );
    expect(JSON.parse(init.body)).toEqual({ claimedBy: "inspector-7" });
  });

  it("reads an empty queue as nothing to do", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, claimed: null })),
    );
    await expect(claimNextForTests("inspector-7")).resolves.toBeNull();
  });

  it("reads a 404 as the feature being off backend-side", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(404, { ok: false })),
    );
    await expect(claimNextForTests("inspector-7")).resolves.toBe("disabled");
  });

  it("throws on any other failure so the loop backs off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, { ok: false })),
    );
    await expect(claimNextForTests("inspector-7")).rejects.toThrow(
      /claim failed \(500\)/,
    );
  });
});

describe("startScheduledEvalsWorker", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not start without the service credentials", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    await startScheduledEvalsWorker().stop();

    // `fetch` alone cannot prove the gate: without credentials the transport
    // throws before `fetch` anyway. The loop logs "worker started"
    // synchronously, so its absence is what shows the gate held.
    expect(warnSpy).toHaveBeenCalledWith(
      "[scheduled-evals] worker enabled but CONVEX_HTTP_URL / INSPECTOR_SERVICE_TOKEN missing; not starting",
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      "[scheduled-evals] worker started",
      expect.anything(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs a claimed trigger through to its completion report", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    vi.stubEnv("RAILWAY_REPLICA_ID", "replica-1");
    const requests: Array<{ path: string; body: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        requests.push({ path, body: JSON.parse(String(init.body)) });
        // No project: the run reports back at once, with no other I/O.
        const claimed = { ...CLAIM, projectId: null };
        return jsonResponse(
          200,
          path.endsWith("/claim")
            ? { ok: true, claimed: requests.length === 1 ? claimed : null }
            : { ok: true },
        );
      }),
    );
    vi.spyOn(logger, "info").mockImplementation(() => {});

    const worker = startScheduledEvalsWorker();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    await worker.stop();

    expect(requests).toEqual([
      {
        path: "/internal/v1/scheduled-eval-runs/claim",
        body: { claimedBy: "inspector-replica-1" },
      },
      {
        path: "/internal/v1/scheduled-eval-runs/complete",
        body: expect.objectContaining({ triggerId: "trig-1", ok: false }),
      },
    ]);
  });

  it("logs its lines as literals the telemetry catalog keeps", () => {
    expect(catalog.messages).toEqual(
      expect.arrayContaining([
        "[scheduled-evals] worker started",
        "[scheduled-evals] poll failed",
        "[scheduled-evals] worker stopped",
      ]),
    );
  });
});

describe("classifyFailure", () => {
  it("maps the canonical billing-limit code to quota_exhausted (pauses the schedule)", () => {
    expect(
      classifyFailure(new Error("billing_limit_reached: eval iterations")),
    ).toBe("quota_exhausted");
  });

  it("maps the org spend-budget refusal to quota_exhausted", () => {
    // Both canonical markers reach this classifier: the `/stream` wire code
    // and the launch mutation's ConvexError code. Either one must pause the
    // schedule rather than retry into the same cap next window.
    expect(classifyFailure(new Error("spend_budget_reached"))).toBe(
      "quota_exhausted",
    );
    expect(
      classifyFailure(
        new Error('{"code":"ORGANIZATION_SPEND_BUDGET_REACHED"}'),
      ),
    ).toBe("quota_exhausted");
  });

  it("does not pause on an unrelated error that merely mentions a budget", () => {
    // The loose-substring failure mode this classifier exists to avoid: an
    // MCP server error naming "budget" is a plain failure, not a cap.
    expect(classifyFailure(new Error("tool failed: budget lookup"))).toMatch(
      /^run_create_failed:/,
    );
  });

  it("maps delegated-mint 401/403 failures to auth (pauses the schedule)", () => {
    expect(
      classifyFailure(new Error("Delegated token exchange failed (403)")),
    ).toBe("auth");
    expect(
      classifyFailure(new Error("Delegated token exchange failed (401)")),
    ).toBe("auth");
  });

  it("does NOT pause on loose substring matches (retryable failures stay retryable)", () => {
    // An MCP server error merely mentioning these words must not pause
    // the schedule.
    expect(
      classifyFailure(new Error("server replied: quota header missing")),
    ).toMatch(/^run_create_failed: /);
    expect(
      classifyFailure(new Error("upstream FORBIDDEN while fetching tools")),
    ).toMatch(/^run_create_failed: /);
    expect(
      classifyFailure(new Error("user is not a member of channel #general")),
    ).toMatch(/^run_create_failed: /);
  });

  it("falls back to a bounded run_create_failed reason", () => {
    const reason = classifyFailure(new Error("x".repeat(500)));
    expect(reason.startsWith("run_create_failed: ")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(
      "run_create_failed: ".length + 160,
    );
  });
});

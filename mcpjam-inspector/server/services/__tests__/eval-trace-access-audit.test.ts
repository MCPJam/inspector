import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportRouteFailureMock } = vi.hoisted(() => ({
  reportRouteFailureMock: vi.fn(),
}));
vi.mock("../../utils/route-error-report.js", () => ({
  reportRouteFailure: reportRouteFailureMock,
}));

import { recordEvalIterationRead } from "../eval-trace-access-audit.js";

const audit = {
  convexAuthToken: "user-jwt",
  iterationId: "iter_1",
  mode: "trace" as const,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => Response.json({ ok: true, recorded: true }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  reportRouteFailureMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("recordEvalIterationRead", () => {
  it("posts both credentials on a hosted server", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    await recordEvalIterationRead(audit);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://backend.test/internal/v1/evals/iteration-read",
    );
    expect(init.headers["x-inspector-service-token"]).toBe("svc-token");
    expect(init.headers.authorization).toBe("Bearer user-jwt");
  });

  it("skips quietly on a self-hosted server: hosted-only by design, not a failure", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    await recordEvalIterationRead(audit);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reportRouteFailureMock).not.toHaveBeenCalled();
  });
});

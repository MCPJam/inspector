/**
 * The readiness transport, on both sides of the local/hosted line.
 *
 * The panel's tests mock this module wholesale, which is right for them and
 * leaves this layer unguarded. What it does is small but not obvious: it picks
 * a universe from the build mode, narrows a value before it goes on the wire
 * because one universe accepts fewer of them than the other, and encodes run
 * ids into paths.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const hostedRef = { current: false };

vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return hostedRef.current;
  },
}));

vi.mock("@/lib/apis/mode-client", () => ({
  isHostedMode: () => hostedRef.current,
  runByMode: <T>(options: {
    hosted: () => Promise<T>;
    local: () => Promise<T>;
  }) => (hostedRef.current ? options.hosted() : options.local()),
}));

const localPostMock = vi.fn();
const webPostMock = vi.fn();
const webGetMock = vi.fn();

vi.mock("@/lib/apis/local-post", () => ({
  localPost: (...args: unknown[]) => localPostMock(...args),
}));
vi.mock("@/lib/apis/web/base", () => ({
  webPost: (...args: unknown[]) => webPostMock(...args),
  webGet: (...args: unknown[]) => webGetMock(...args),
}));
vi.mock("@/lib/apis/web/context", () => ({
  buildServerRequest: () => ({ projectId: "proj_1", serverId: "srv_1" }),
  getHostedProjectId: () => "proj_1",
}));

import {
  canRequestModelObservations,
  cancelHostedReadinessRun,
  getHostedReadinessReport,
  getHostedReadinessRun,
  startDirectoryReadiness,
} from "../mcp-readiness-api";

beforeEach(() => {
  vi.clearAllMocks();
  hostedRef.current = false;
});

describe("startDirectoryReadiness — local", () => {
  it("posts to the publisher's local route and hands back the result", async () => {
    localPostMock.mockResolvedValue({ result: { status: "ready", lanes: [] } });
    const outcome = await startDirectoryReadiness({
      serverNameOrId: "srv_1",
      publisher: "claude",
    });
    expect(localPostMock).toHaveBeenCalledWith(
      "/api/mcp/conformance/readiness/claude",
      { serverId: "srv_1" },
    );
    expect(outcome).toEqual({
      mode: "local",
      result: { status: "ready", lanes: [] },
    });
  });

  it("keeps the WIDER submission union locally — a local run can read a package", async () => {
    localPostMock.mockResolvedValue({ result: { status: "ready", lanes: [] } });
    await startDirectoryReadiness({
      serverNameOrId: "srv_1",
      publisher: "openai",
      submissionMode: "mcp-uploaded-skills",
    });
    expect(localPostMock).toHaveBeenCalledWith(
      "/api/mcp/conformance/readiness/openai",
      { serverId: "srv_1", submissionMode: "mcp-uploaded-skills" },
    );
  });

  it("never sends the billed opt-in on the local path", async () => {
    // A local run has no broker, no lease and no payer. The local route has no
    // field for it, so sending one would be a body key the schema drops.
    localPostMock.mockResolvedValue({ result: { status: "ready", lanes: [] } });
    await startDirectoryReadiness({
      serverNameOrId: "srv_1",
      publisher: "claude",
      includeLlmObservations: true,
    });
    const [, body] = localPostMock.mock.calls[0]!;
    expect(body).not.toHaveProperty("includeLlmObservations");
  });

  it("propagates a transport rejection rather than inventing a result", async () => {
    localPostMock.mockRejectedValue(new Error("the server said no"));
    await expect(
      startDirectoryReadiness({ serverNameOrId: "srv_1", publisher: "claude" }),
    ).rejects.toThrow("the server said no");
  });
});

describe("startDirectoryReadiness — hosted", () => {
  beforeEach(() => {
    hostedRef.current = true;
  });

  it("carries the project/server context and an explicit opt-in", async () => {
    webPostMock.mockResolvedValue({ run: { runId: "run_1" } });
    const outcome = await startDirectoryReadiness({
      serverNameOrId: "srv_1",
      publisher: "claude",
      includeLlmObservations: true,
    });
    expect(webPostMock).toHaveBeenCalledWith(
      "/api/web/conformance/readiness/claude",
      {
        projectId: "proj_1",
        serverId: "srv_1",
        includeLlmObservations: true,
      },
    );
    expect(outcome).toEqual({ mode: "hosted", receipt: { runId: "run_1" } });
  });

  it("defaults the opt-in to false rather than omitting it", async () => {
    // Explicit, so a body-shape change cannot silently flip the default.
    webPostMock.mockResolvedValue({ run: { runId: "run_1" } });
    await startDirectoryReadiness({
      serverNameOrId: "srv_1",
      publisher: "claude",
    });
    const [, body] = webPostMock.mock.calls[0]!;
    expect(body.includeLlmObservations).toBe(false);
  });

  it("DROPS a package submission mode the hosted endpoint cannot grade", async () => {
    // The archive lives on the caller's disk. Forwarding the word would draw
    // an opaque enum rejection; dropping it draws the route's own refusal,
    // which at least names the problem.
    webPostMock.mockResolvedValue({ run: { runId: "run_1" } });
    await startDirectoryReadiness({
      serverNameOrId: "srv_1",
      publisher: "openai",
      submissionMode: "mcp-uploaded-skills",
    });
    const [, body] = webPostMock.mock.calls[0]!;
    expect(body).not.toHaveProperty("submissionMode");
  });

  it("passes the two modes a hosted run CAN grade", async () => {
    webPostMock.mockResolvedValue({ run: { runId: "run_1" } });
    for (const mode of ["mcp-only", "mcp-imported-skills"] as const) {
      webPostMock.mockClear();
      await startDirectoryReadiness({
        serverNameOrId: "srv_1",
        publisher: "openai",
        submissionMode: mode,
      });
      const [, body] = webPostMock.mock.calls[0]!;
      expect(body.submissionMode).toBe(mode);
    }
  });
});

describe("run reads and writes", () => {
  it("asks for a run by id under its project", async () => {
    webGetMock.mockResolvedValue({ run: { id: "run_1" } });
    const run = await getHostedReadinessRun("run_1");
    expect(webGetMock).toHaveBeenCalledWith(
      "/api/web/conformance/readiness/runs/run_1?projectId=proj_1",
    );
    expect(run).toEqual({ id: "run_1" });
  });

  it("encodes a run id that would otherwise change the path", async () => {
    // Ids are server-minted, but a caller can pass anything, and an unencoded
    // slash would silently address a different route.
    webGetMock.mockResolvedValue({ run: {} });
    await getHostedReadinessRun("run/../other");
    expect(webGetMock).toHaveBeenCalledWith(
      "/api/web/conformance/readiness/runs/run%2F..%2Fother?projectId=proj_1",
    );
  });

  it("cancels by id, with an empty body", async () => {
    webPostMock.mockResolvedValue({});
    await cancelHostedReadinessRun("run 1");
    expect(webPostMock).toHaveBeenCalledWith(
      "/api/web/conformance/readiness/runs/run%201/cancel",
      {},
    );
  });

  it("fetches the report from its own endpoint", async () => {
    // Separate from the row on purpose: the row carries lane statuses, the
    // report carries every finding and can reach megabytes.
    webGetMock.mockResolvedValue({ status: "ready", findings: [] });
    const report = await getHostedReadinessReport("run_1");
    expect(webGetMock).toHaveBeenCalledWith(
      "/api/web/conformance/readiness/runs/run_1/report",
    );
    expect(report).toEqual({ status: "ready", findings: [] });
  });

  it("lets a transport error through with its own message", async () => {
    // `webGet` throws a `WebApiError` carrying status and code. Wrapping it in
    // a plain Error here would lose the 404-vs-502 distinction the route takes
    // care to make.
    webGetMock.mockRejectedValue(new Error("Request failed (404)"));
    await expect(getHostedReadinessRun("run_1")).rejects.toThrow(
      "Request failed (404)",
    );
  });
});

describe("canRequestModelObservations", () => {
  it("is a capability, not a preference", async () => {
    hostedRef.current = false;
    expect(canRequestModelObservations()).toBe(false);
    hostedRef.current = true;
    expect(canRequestModelObservations()).toBe(true);
  });
});

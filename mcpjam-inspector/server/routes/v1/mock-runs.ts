/**
 * Public `/api/v1` test runs of a mock server: open one, reset it, close it.
 * A run pins a version of the mock and gives an external client its own copy
 * of the version's records, at a URL only the person who opened it can use
 * (the backend decides on every request). The tiers, the flag and the run's
 * lifetime are the backend's, called with the caller's own bearer.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { PlatformMockRun, PlatformMockRunClosed } from "@mcpjam/sdk/platform";
import { mockServerBaseUrl } from "../../services/mock/address.js";
import { MOCK_ROUTE_PREFIX } from "../../../shared/mock-address.js";
import { parseWithSchema } from "../web/errors.js";
import { readJsonObjectBody } from "./adapter.js";
import { requireProjectIdArg } from "./convex-id-param.js";
import { v1Resource } from "./envelope.js";
import { bearerOf, readMock } from "./mock-server-io.js";
import { closeRun, openRun, resetRun, type BackendRun } from "./mock-runs-backend.js";
import { translateMockWriteError } from "./mock-server-support.js";

const mockRuns = new Hono();

const openBody = z.strictObject({
  version: z.number().int().min(1).optional(),
  platformRunId: z.string().trim().min(1).max(200).optional(),
});
const resetBody = z.strictObject({ expectedEpoch: z.number().int().min(1) });

function projectIdOf(c: Context): string {
  const projectId = c.req.param("projectId") ?? "";
  requireProjectIdArg(projectId, "v1.mock-runs");
  return projectId;
}

/** A backend call, with its refusals as public errors. */
async function backendOf<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translateMockWriteError(error);
  }
}

/** The mock a run's path names; the backend built the path, so it is the run's own mock. */
function mockIdOfPath(mcpPath: string): string {
  const path = new URL(mcpPath, "http://run.invalid").pathname;
  return decodeURIComponent(path.slice(path.indexOf(MOCK_ROUTE_PREFIX) + MOCK_ROUTE_PREFIX.length + 1));
}

function dto(projectId: string, run: BackendRun): PlatformMockRun {
  const base = mockServerBaseUrl();
  return {
    runId: run.runId,
    mockId: mockIdOfPath(run.mcpPath),
    projectId,
    version: run.version,
    epoch: run.epoch,
    expiresAt: run.expiresAt,
    // The URL's origin is this Inspector's configured one, never the request's.
    runUrl: base ? `${base}${run.mcpPath}` : null,
  };
}

// POST /v1/projects/:projectId/mock-servers/:mockId/runs: open a run on a version (the head by default).
mockRuns.post("/projects/:projectId/mock-servers/:mockId/runs", async (c) => {
  const projectId = projectIdOf(c);
  const mockId = c.req.param("mockId") ?? "";
  const body = parseWithSchema(openBody, await readJsonObjectBody(c));
  // The path names a project; a mock in another one is not found here.
  await readMock(c, projectId, mockId);
  const run = await backendOf(async () => openRun(await bearerOf(c), { mockId, ...body }));
  return v1Resource(c, dto(projectId, run), 201);
});

// POST /v1/projects/:projectId/mock-servers/:mockId/runs/:runId/reset: back to the pinned seed, at a new epoch and URL.
mockRuns.post("/projects/:projectId/mock-servers/:mockId/runs/:runId/reset", async (c) => {
  const projectId = projectIdOf(c);
  const body = parseWithSchema(resetBody, await readJsonObjectBody(c));
  const run = await backendOf(async () =>
    resetRun(await bearerOf(c), { runId: c.req.param("runId") ?? "", expectedEpoch: body.expectedEpoch }),
  );
  return v1Resource(c, dto(projectId, run));
});

// POST /v1/projects/:projectId/mock-servers/:mockId/runs/:runId/close: ends access at once. Safe to repeat.
mockRuns.post("/projects/:projectId/mock-servers/:mockId/runs/:runId/close", async (c) => {
  const projectId = projectIdOf(c);
  const runId = c.req.param("runId") ?? "";
  await backendOf(async () => closeRun(await bearerOf(c), { runId }));
  const closed: PlatformMockRunClosed = { runId, projectId, closed: true };
  return v1Resource(c, closed);
});

export default mockRuns;

/**
 * The test run routes: open, reset and close. Convex is mocked at
 * `convex/browser`, so these prove the gateway: what it checks before the
 * backend is called, the URL it builds, and how each backend refusal is
 * answered. The run's own rules (owner, epochs, expiry) are the backend's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({ guest: vi.fn(), query: vi.fn(), mutation: vi.fn() }));

vi.mock("../../../services/mock/address.js", () => ({
  mockServerBaseUrl: () => "https://inspector.test",
  mockServerAddress: (mockId: string) => `https://inspector.test/api/web/mock-mcp/${mockId}`,
}));
vi.mock("../../../services/guest-token.js", () => ({ validateGuestTokenDetailedAsync: mocks.guest }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return { setAuth: vi.fn(), query: mocks.query, mutation: mocks.mutation };
  }),
}));

import v1Routes from "../index.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../../sdk/tests/fixtures/mock-surfaces.json", import.meta.url), "utf8"),
) as Record<string, any>;
const { project: PROJECT, mock: MOCK } = fixture.ids as Record<string, string>;
const RUNS = `/api/v1/projects/${PROJECT}/mock-servers/${MOCK}/runs`;
const PATH = `/api/web/mock-mcp/${MOCK}?run=run-1&epoch=`;

type Handler = (args: Record<string, any>) => unknown;
let mutations: Record<string, Handler>;
const nameOf = (value: unknown) => getFunctionName(value as never);
const calls = (name: string) => mocks.mutation.mock.calls.filter(([fn]) => nameOf(fn) === name).map(([, args]) => args);

function post(path: string, body: unknown = {}) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`https://inspector.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
    body: JSON.stringify(body),
  });
}
const json = async (response: Response | Promise<Response>) => (await (await response).json()) as Record<string, any>;
const refused = (code: string, message: string, extra: object = {}) => new ConvexError({ code, message, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.example.com");
  mocks.guest.mockResolvedValue({ valid: false });
  mocks.query.mockImplementation(async () => ({
    mockId: MOCK,
    projectId: PROJECT,
    name: "markets (mock)",
    baseServerId: null,
    headVersion: 2,
    version: 2,
    contentHash: "h",
    definitionJson: "{}",
  }));
  mutations = {
    "mockRuns:open": () => ({ runId: "run-1", version: 2, epoch: 1, expiresAt: 1790000000000, mcpPath: `${PATH}1` }),
    "mockRuns:reset": (args) => ({ runId: "run-1", version: 2, epoch: args.expectedEpoch + 1, expiresAt: 1790000000000, mcpPath: `${PATH}${args.expectedEpoch + 1}` }),
    "mockRuns:close": () => ({ closed: true }),
  };
  mocks.mutation.mockImplementation(async (fn, args) => mutations[nameOf(fn)]!(args));
});

describe("opening a run", () => {
  it("pins a version, and answers the run with the URL on this Inspector's own origin", async () => {
    const response = await post(RUNS, { version: 2, platformRunId: "eval-9" });
    expect(response.status).toBe(201);
    expect(await json(response)).toEqual(fixture.run);
    expect(calls("mockRuns:open")).toEqual([{ mockId: MOCK, version: 2, platformRunId: "eval-9" }]);
  });

  it("does not open a run on a mock the path's project does not hold", async () => {
    mocks.query.mockImplementation(async () => ({ mockId: MOCK, projectId: "other", name: "m", headVersion: 1, version: 1, definitionJson: "{}" }));
    expect((await post(RUNS)).status).toBe(404);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("refuses a body with anything else in it", async () => {
    expect((await post(RUNS, { version: 0 })).status).toBe(400);
    expect((await post(RUNS, { unexpected: true })).status).toBe(400);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("names the flag when the backend says it is off", async () => {
    mutations["mockRuns:open"] = () => {
      throw refused("MOCK_SERVERS_FLAG_OFF", "off");
    };
    const response = await post(RUNS);
    expect(response.status).toBe(403);
    expect((await json(response)).message).toContain("mock-servers-enabled");
  });
});

describe("the limit on open runs", () => {
  it("is a 409 with the code and the limit, in words that say what to do", async () => {
    mutations["mockRuns:open"] = () => {
      throw refused("MOCK_RUN_LIMIT", "backend wording", { limit: 100 });
    };
    const response = await post(RUNS);
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.details).toMatchObject({ code: "MOCK_RUN_LIMIT", limit: 100 });
    expect(body.message).toBe("You have 100 open test runs. Close one, or wait for one to expire; a run lasts 24 hours.");
  });
});

describe("resetting a run", () => {
  it("answers the next epoch's URL, and sends the epoch it holds", async () => {
    const response = await post(`${RUNS}/run-1/reset`, { expectedEpoch: 1 });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual(fixture.reset);
    expect(calls("mockRuns:reset")).toEqual([{ runId: "run-1", expectedEpoch: 1 }]);
  });

  it("answers 409 with the run's current epoch when the caller's is old", async () => {
    mutations["mockRuns:reset"] = () => {
      throw refused("MOCK_RUN_STALE_EPOCH", "This run is at epoch 3. Read it again.", { currentEpoch: 3 });
    };
    const response = await post(`${RUNS}/run-1/reset`, { expectedEpoch: 1 });
    expect(response.status).toBe(409);
    expect((await json(response)).details).toMatchObject({ code: "MOCK_RUN_STALE_EPOCH", currentEpoch: 3 });
  });

  it("needs the epoch", async () => {
    expect((await post(`${RUNS}/run-1/reset`, {})).status).toBe(400);
  });
});

describe("closing a run", () => {
  it("answers closed, and a repeat is the backend's idempotent answer", async () => {
    const response = await post(`${RUNS}/run-1/close`);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual(fixture.closed);
    expect(calls("mockRuns:close")).toEqual([{ runId: "run-1" }]);
  });
});

describe("a run that cannot be used", () => {
  it.each([
    ["MOCK_RUN_CLOSED", 409],
    ["MOCK_RUN_EXPIRED", 409],
    ["MOCK_RUN_NOT_FOUND", 404],
    ["MOCK_RUN_FORBIDDEN", 403],
  ])("%s is %i, with its code and the backend's wording", async (code, status) => {
    mutations["mockRuns:reset"] = () => {
      throw refused(code, "Open a new run.");
    };
    const response = await post(`${RUNS}/run-1/reset`, { expectedEpoch: 1 });
    expect(response.status).toBe(status);
    const body = await json(response);
    expect(body.details).toMatchObject({ code });
    expect(body.message).toBe("Open a new run.");
  });
});

/**
 * The v1 trace-destination write schema accepts `event`, background trigger
 * runs, beside the four older source types, and stores it as written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { queryMock, actionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  actionMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    action(...args: unknown[]) {
      return actionMock(...args);
    }
    mutation() {
      throw new Error("no mutation expected");
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
}));

import traceDestinations from "../trace-destinations.js";
import { v1OnError } from "../envelope.js";

const ORG = "org_1";

function row(sourceTypes: string[]) {
  return {
    id: "td_1",
    organizationId: ORG,
    name: "Collector",
    enabled: true,
    endpointUrl: "https://collector.example.com/v1/traces",
    headerNames: [],
    resourceAttributes: {},
    sourceTypes,
    includeContent: false,
    compression: "none",
    projectIds: null,
    preset: null,
    paused: null,
    health: null,
    lastTest: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function create(sourceTypes: unknown) {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", traceDestinations);
  return app.request(`/api/v1/organizations/${ORG}/trace-destinations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Collector",
      endpointUrl: "https://collector.example.com",
      sourceTypes,
    }),
  });
}

describe("v1 trace destinations: the event source type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONVEX_URL", "https://convex.example.com");
    actionMock.mockResolvedValue("td_1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores and returns event as written", async () => {
    queryMock.mockResolvedValue(row(["direct", "event"]));
    const response = await create(["direct", "event"]);
    expect(response.status).toBe(201);
    expect(actionMock.mock.calls[0]?.[1]).toMatchObject({
      sourceTypes: ["direct", "event"],
    });
    const body = await response.json();
    expect(body.sourceTypes).toEqual(["direct", "event"]);
  });

  it("accepts every stored source type at once", async () => {
    const all = ["eval", "scenario", "swarm", "direct", "event"];
    queryMock.mockResolvedValue(row(all));
    const response = await create(all);
    expect(response.status).toBe(201);
    expect(actionMock.mock.calls[0]?.[1]).toMatchObject({ sourceTypes: all });
  });

  it("still refuses a source type it does not know", async () => {
    const response = await create(["events"]);
    expect(response.status).toBe(400);
    expect(actionMock).not.toHaveBeenCalled();
  });
});

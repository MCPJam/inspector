import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  quoteSwarmLaunchOperation,
} from "../../src/platform/index.js";

/**
 * `quote_swarm_launch` prices a launch before it runs. It must send exactly
 * the plan it was given, field by field, since the route refuses a key it
 * does not know, and it must never spend: it is a read.
 */

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};

const QUOTE = {
  sessions: 4,
  starterSessions: 2,
  creditSessions: 2,
  creditsRequiredP50: 10,
  creditsRequiredP90: 16,
  admitThreshold: 16,
  creditsAvailable: 30,
  maxAffordableSessions: 4,
  fits: true,
  resetsAt: null,
  priors: "measured",
  perRun: [],
  lines: [],
};

function makeClient() {
  const fetchMock = vi.fn(async (target: unknown, _init?: RequestInit) => {
    const path = new URL(String(target)).pathname;
    if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
    if (path === `/api/v1/projects/${PROJECT.id}/swarms/quote`)
      return Response.json(QUOTE);
    return new Response("not found", { status: 404 });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

describe("quote_swarm_launch", () => {
  it("is a read, so it declares no risk", () => {
    expect(quoteSwarmLaunchOperation.readOnly).toBe(true);
    expect(quoteSwarmLaunchOperation.risk).toBeUndefined();
  });

  it("posts the plan as given and returns the quote", async () => {
    const { client, fetchMock } = makeClient();
    const input = quoteSwarmLaunchOperation.inputSchema.parse({
      project: PROJECT.id,
      plannedRuns: [
        { goalId: "goal-1", iterations: 2 },
        { key: "bare", environmentIds: ["env-1"], maxTurns: 6 },
      ],
    });

    const result = await quoteSwarmLaunchOperation.execute(input, { client });

    expect(result).toEqual({
      project: expect.objectContaining({ id: PROJECT.id }),
      quote: QUOTE,
    });
    const quoteCall = fetchMock.mock.calls.find(([target]) =>
      String(target).endsWith("/swarms/quote")
    )!;
    expect(quoteCall[1]?.method).toBe("POST");
    expect(JSON.parse(String(quoteCall[1]?.body))).toEqual({
      plannedRuns: [
        { goalId: "goal-1", iterations: 2 },
        { key: "bare", environmentIds: ["env-1"], maxTurns: 6 },
      ],
    });
  });

  it("holds the route's limits: 100 planned runs, 10 environments a run", () => {
    const parse = (plannedRuns: unknown[]) =>
      quoteSwarmLaunchOperation.inputSchema.safeParse({ plannedRuns }).success;
    const runs = (n: number) =>
      Array.from({ length: n }, () => ({ goalId: "goal-1" }));
    const envs = (n: number) => Array.from({ length: n }, () => "env-1");

    expect(parse(runs(100))).toBe(true);
    expect(parse(runs(101))).toBe(false);
    expect(parse([{ goalId: "goal-1", environmentIds: envs(10) }])).toBe(true);
    expect(parse([{ goalId: "goal-1", environmentIds: envs(11) }])).toBe(false);
  });

  it("refuses an empty plan before any request", () => {
    expect(
      quoteSwarmLaunchOperation.inputSchema.safeParse({ plannedRuns: [] })
        .success
    ).toBe(false);
  });
});

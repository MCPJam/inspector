import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  PlatformApiError,
  describeSwarmFundingChange,
} from "../../src/platform/index.js";
import {
  launchGoalRunOperation,
  launchJourneyRunOperation,
} from "../../src/platform/operations.js";

function clientWith(respond: (init: RequestInit, url: string) => Response) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return respond(init ?? {}, String(url));
  });
  const client = new PlatformApiClient({
    getAuth: () => "sk_test",
    baseUrl: "https://api.test/api/v1",
    fetch: fetchImpl as unknown as typeof fetch,
  });
  return { client, requests };
}

describe("expectedSponsored on goal launches", () => {
  it("launchGoalRun sends expectedSponsored (including 0) and omits it otherwise", async () => {
    const { client, requests } = clientWith(() =>
      Response.json({
        id: "run_1",
        goalId: "g",
        projectId: "p",
        status: "running",
        deduped: false,
        funding: { sponsored: 0, credits: 2, total: 2 },
      })
    );

    const launched = await client.launchGoalRun({
      projectId: "p",
      goalId: "g",
      expectedSponsored: 0,
    });
    await client.launchGoalRun({ projectId: "p", goalId: "g" });

    expect(requests[0]!.url).toContain("/projects/p/goals/g/runs");
    expect(requests[0]!.body).toEqual({ expectedSponsored: 0 });
    expect(requests[1]!.body).toEqual({});
    expect(launched.funding).toEqual({ sponsored: 0, credits: 2, total: 2 });
  });

  it("the deprecated launchJourneyRun carries it too", async () => {
    const { client, requests } = clientWith(() =>
      Response.json({
        id: "r",
        journeyId: "j",
        projectId: "p",
        status: "running",
        deduped: false,
      })
    );
    await client.launchJourneyRun({
      projectId: "p",
      journeyId: "j",
      expectedSponsored: 3,
    });
    expect(requests[0]!.body).toEqual({ expectedSponsored: 3 });
  });

  it("the operation schemas accept a whole non-negative count and refuse the rest", () => {
    for (const schema of [
      launchGoalRunOperation.inputSchema,
      launchJourneyRunOperation.inputSchema,
    ]) {
      const base =
        schema === launchGoalRunOperation.inputSchema
          ? { goalId: "g" }
          : { journey: "j" };
      expect(schema.safeParse({ ...base, expectedSponsored: 0 }).success).toBe(
        true
      );
      expect(schema.safeParse({ ...base, expectedSponsored: -1 }).success).toBe(
        false
      );
      expect(
        schema.safeParse({ ...base, expectedSponsored: 1.5 }).success
      ).toBe(false);
    }
  });
});

describe("describeSwarmFundingChange", () => {
  const conflict = (details: Record<string, unknown> | undefined) =>
    new PlatformApiError("Sponsored conversations changed.", "CONFLICT", {
      status: 409,
      details,
    });

  it("reads the typed 409 a launch answers when the split moved", async () => {
    const { client } = clientWith(() =>
      Response.json(
        {
          code: "CONFLICT",
          message: "changed",
          details: {
            code: "swarm_funding_changed",
            expectedSponsored: 5,
            actualSponsored: 3,
            totalConversations: 15,
          },
        },
        { status: 409 }
      )
    );

    const error = await client
      .launchGoalRun({ projectId: "p", goalId: "g", expectedSponsored: 5 })
      .catch((e) => e);

    expect(describeSwarmFundingChange(error)).toEqual({
      expectedSponsored: 5,
      actualSponsored: 3,
      totalConversations: 15,
    });
  });

  it("is undefined for other conflicts, other statuses and malformed details", () => {
    expect(
      describeSwarmFundingChange(conflict({ code: "other" }))
    ).toBeUndefined();
    expect(describeSwarmFundingChange(conflict(undefined))).toBeUndefined();
    expect(
      describeSwarmFundingChange(
        conflict({ code: "swarm_funding_changed", expectedSponsored: "5" })
      )
    ).toBeUndefined();
    expect(describeSwarmFundingChange(new Error("x"))).toBeUndefined();
    expect(
      describeSwarmFundingChange(
        new PlatformApiError("m", "FORBIDDEN", {
          status: 403,
          details: {
            code: "swarm_funding_changed",
            expectedSponsored: 1,
            actualSponsored: 0,
            totalConversations: 1,
          },
        })
      )
    ).toBeUndefined();
  });
});

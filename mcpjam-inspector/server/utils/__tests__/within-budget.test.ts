import { describe, expect, it } from "vitest";
import { withinToolListingBudget } from "../within-budget.js";
import {
  HOSTED_REQUEST_TIMEOUT_DETAIL,
  describeHostedConnectFailure,
} from "../hosted-connect-failure.js";
import { ErrorCode, mapTargetServerError } from "../../routes/web/errors.js";

async function expiredBudgetError(): Promise<Error> {
  try {
    await withinToolListingBudget(new Promise(() => {}), 0, () => '"srv_1"');
  } catch (error) {
    return error as Error;
  }
  throw new Error("the budget did not expire");
}

describe("withinToolListingBudget", () => {
  it("returns the listing when it finishes in time", async () => {
    await expect(
      withinToolListingBudget(Promise.resolve("tools"), 1_000, () => '"s"'),
    ).resolves.toBe("tools");
  });

  it("is the listing itself with no budget", async () => {
    const listing = Promise.resolve("tools");
    await expect(
      withinToolListingBudget(listing, undefined, () => '"s"'),
    ).resolves.toBe("tools");
  });

  it("fails an expired budget as a 424 TIMEOUT naming the server", async () => {
    const error = await expiredBudgetError();
    expect(error.name).toBe("TimeoutError");
    expect(error.message).toMatch(/^MCP server "srv_1" timed out/);
    const mapped = mapTargetServerError(error);
    expect(mapped.status).toBe(424);
    expect(mapped.code).toBe(ErrorCode.TIMEOUT);
  });

  it("is worded on hosted as a request that got no answer in time", async () => {
    // Not by the last logged exchange: the hung connect may have logged an
    // earlier answer, which would misreport why it failed.
    const logs = {
      _httpLogs: [
        {
          exchange: {
            request: { method: "POST", url: "https://mcp.example.test/mcp" },
            response: { status: 200, statusText: "OK" },
          },
        },
      ],
    };
    expect(
      describeHostedConnectFailure(await expiredBudgetError(), logs).message,
    ).toBe(HOSTED_REQUEST_TIMEOUT_DETAIL);
  });
});

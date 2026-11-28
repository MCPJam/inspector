import { describe, expect, it } from "vitest";
import { ErrorCode, WebRouteError } from "../../../routes/web/errors.js";
import {
  classifySwarmLaunchError,
  describeSwarmLaunchError,
} from "../errors.js";
import { refusals } from "./swarm-fakes.js";

describe("what a failed goal start means for the launch", () => {
  it.each([
    ["400", refusals.invalid()],
    ["404", refusals.missing()],
    ["422", refusals.unprocessable()],
    ["a 409 other than a funding change", refusals.conflict()],
  ])("%s fails only that goal", (_name, error) => {
    expect(classifySwarmLaunchError(error)).toBe("item_failed");
  });

  it.each([
    ["402", refusals.billing(), undefined],
    ["an MCPJam usage limit", refusals.usageLimit(), undefined],
    ["the daily run limit", refusals.dailyRunLimit(), 40_000_000],
    ["409 swarm_funding_changed", refusals.fundingChanged(), undefined],
    ["a policy 403", refusals.policy(), undefined],
    ["a draining server", refusals.draining(), 5_000],
  ])("%s stops the launch", (_name, error, retryAfterMs) => {
    expect(classifySwarmLaunchError(error)).toEqual({
      stop: describeSwarmLaunchError(error),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  });

  it("stops on a 401 as AUTH_EXPIRED, so a replay or resume finishes the launch", () => {
    expect(classifySwarmLaunchError(refusals.expired())).toEqual({
      stop: {
        status: 401,
        code: "AUTH_EXPIRED",
        message:
          "The sign-in this launch used expired before every goal started. Launch it again to start the rest.",
      },
    });
  });

  it("waits out a throttle for as long as it says, the engine capping it", () => {
    expect(classifySwarmLaunchError(refusals.throttled(12))).toEqual({
      wait: 12_000,
    });
    expect(classifySwarmLaunchError(refusals.throttled(120))).toEqual({
      wait: 120_000,
    });
    expect(classifySwarmLaunchError(refusals.throttled())).toEqual({
      wait: 5_000,
    });
  });

  it.each([
    ["a backend 5xx", refusals.serverError()],
    ["a network failure", refusals.network()],
    [
      "a route 500",
      new WebRouteError(500, ErrorCode.INTERNAL_ERROR, "Server missing config"),
    ],
  ])("retries %s", (_name, error) => {
    expect(classifySwarmLaunchError(error)).toBe("retry");
  });
});

describe("what the record keeps about it", () => {
  it("keeps a route error's status, its backend code and its message", () => {
    expect(describeSwarmLaunchError(refusals.unprocessable())).toEqual({
      status: 422,
      code: "org_model_unconfigured",
      message: "This organization has no model set up for that role.",
    });
    expect(describeSwarmLaunchError(refusals.missing())).toEqual({
      status: 404,
      code: "NOT_FOUND",
      message: "This goal was not found.",
    });
  });

  it("never keeps a transport failure's own words", () => {
    expect(describeSwarmLaunchError(refusals.serverError())).toEqual({
      status: 503,
      message:
        "MCPJam could not start this goal's run. Launch again to retry it.",
    });
    expect(describeSwarmLaunchError(refusals.network())).toEqual({
      message:
        "MCPJam could not start this goal's run. Launch again to retry it.",
    });
  });
});

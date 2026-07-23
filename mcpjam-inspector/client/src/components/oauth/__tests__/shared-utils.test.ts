import { describe, expect, it } from "vitest";
import { getActionStatus } from "../shared/utils";

const actions = [
  { id: "request_without_token" },
  { id: "received_401_unauthorized" },
  { id: "request_resource_metadata" },
];

describe("OAuth sequence action status", () => {
  it("marks the exact current step as current", () => {
    expect(
      getActionStatus(
        "received_401_unauthorized",
        "received_401_unauthorized",
        actions
      )
    ).toBe("current");
  });

  it("keeps the next step pending", () => {
    expect(
      getActionStatus(
        "request_resource_metadata",
        "received_401_unauthorized",
        actions
      )
    ).toBe("pending");
  });

  it("marks only earlier steps complete", () => {
    expect(
      getActionStatus(
        "request_without_token",
        "received_401_unauthorized",
        actions
      )
    ).toBe("complete");
  });

  it("does not activate an action for an internal or skipped state", () => {
    expect(
      getActionStatus("request_without_token", "discovery_start", actions)
    ).toBe("pending");
  });
});

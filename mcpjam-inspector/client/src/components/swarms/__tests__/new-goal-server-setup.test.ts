import { describe, expect, it } from "vitest";
import { newGoalErrorMessage } from "../new-goal-server-setup";
import { SwarmTargetPreflightError } from "../swarm-target-preflight";

describe("new goal server setup errors", () => {
  it.each([
    "NO_SERVER_GROUP",
    "ENV_NOT_FOUND",
    "ENV_ARCHIVED",
    "ENV_ATTACHMENT_MISSING",
    "ENV_NO_SERVERS",
    "ENV_SERVERS_UNRESOLVED",
    "ENV_PLUGIN_UNAVAILABLE",
  ])("explains an invalid setup for %s", (code) => {
    expect(
      newGoalErrorMessage(
        new SwarmTargetPreflightError("Internal detail", code),
      ),
    ).toBe(
      "This goal’s server setup is missing or invalid. Make sure its servers still exist and are explicitly selected.",
    );
  });

  it("preserves model and save errors", () => {
    expect(
      newGoalErrorMessage(
        new SwarmTargetPreflightError("Pick a model", "ENV_MODEL_REQUIRED"),
      ),
    ).toBe("Pick a model");
    expect(newGoalErrorMessage(new Error("Could not save the goal"))).toBe(
      "Could not save the goal",
    );
  });
});

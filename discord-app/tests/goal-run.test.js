import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGoalRunResourceType } from "../goal-run.js";

describe("isGoalRunResourceType", () => {
	it("accepts BOTH spellings, because this app cannot see which one the API sends", () => {
		// Discord deploys from its own workflow, so there is a window where a
		// proposal carrying `goal_run` reaches an app that has not shipped yet.
		// Tolerating both is what closes it.
		for (const type of ["goal_run", "journey_run"]) {
			assert.ok(isGoalRunResourceType(type));
		}
	});

	it("rejects every other resource type", () => {
		// An eval run routed here would be read with the goal status
		// vocabulary, which reports a rate-limited fan-out as a pass.
		for (const type of ["eval_run", "study", "user_testing_scenario", ""]) {
			assert.ok(!isGoalRunResourceType(type));
		}
		assert.ok(!isGoalRunResourceType(undefined));
	});
});

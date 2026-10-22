import { describe, expect, it } from "vitest";
import * as operationsModule from "../../src/platform/operations.js";
import {
  ALL_OPERATIONS,
  OPERATION_FEATURES,
  PLATFORM_FEATURES,
  PLATFORM_FEATURE_KEYS,
  disabledOperations,
  isOperationAvailable,
  operationFeature,
  type PlatformFeatureKey,
} from "../../src/platform/index.js";

/**
 * Every operation the module exports: `ALL_OPERATIONS` plus the deprecated
 * aliases kept out of it. Read from the exports rather than listed here, so a
 * new alias is caught the same way a new operation is.
 */
function exportedOperationNames(): string[] {
  const names = new Set<string>();
  for (const value of Object.values(operationsModule)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { name?: unknown }).name === "string" &&
      typeof (value as { execute?: unknown }).execute === "function" &&
      "inputSchema" in value
    ) {
      names.add((value as { name: string }).name);
    }
  }
  return [...names];
}

const known = new Set<string>(PLATFORM_FEATURE_KEYS);

describe("OPERATION_FEATURES", () => {
  it("lists exactly the operations, deprecated aliases included", () => {
    // A new operation fails here until someone decides its feature.
    const expected = new Set([
      ...ALL_OPERATIONS.map((operation) => operation.name),
      ...exportedOperationNames(),
    ]);
    expect(Object.keys(OPERATION_FEATURES).sort()).toEqual(
      [...expected].sort()
    );
  });

  it("names only known features", () => {
    for (const [name, feature] of Object.entries(OPERATION_FEATURES)) {
      if (feature === null) continue;
      const keys = typeof feature === "string" ? [feature] : feature;
      expect(keys.length, name).toBeGreaterThan(0);
      for (const key of keys)
        expect(known.has(key), `${name}: ${key}`).toBe(true);
    }
  });

  it("labels every feature, and nothing else", () => {
    expect(Object.keys(PLATFORM_FEATURES).sort()).toEqual(
      [...PLATFORM_FEATURE_KEYS].sort()
    );
    expect(new Set(PLATFORM_FEATURE_KEYS).size).toBe(
      PLATFORM_FEATURE_KEYS.length
    );
  });
});

describe("operationFeature", () => {
  it("reads the table, and knows nothing it does not list", () => {
    expect(operationFeature("start_conformance_run")).toBe("conformance");
    expect(operationFeature("get_me")).toBeNull();
    expect(operationFeature("not_an_operation")).toBeUndefined();
    expect(operationFeature("__proto__")).toBeUndefined();
    expect(operationFeature("constructor")).toBeUndefined();
  });

  it("gives a deprecated alias the feature of its replacement", () => {
    expect(operationFeature("list_journeys")).toBe(
      operationFeature("list_goals")
    );
    expect(operationFeature("list_scenarios")).toBe(
      operationFeature("list_studies")
    );
    expect(operationFeature("list_hosts")).toBe(
      operationFeature("list_clients")
    );
  });
});

describe("isOperationAvailable", () => {
  it("keeps released operations available with nothing reported", () => {
    expect(isOperationAvailable("get_me", {})).toBe(true);
    expect(isOperationAvailable("list_chat_sessions", {})).toBe(true);
  });

  it("fails closed on a gated feature that is missing or not true", () => {
    expect(isOperationAvailable("start_conformance_run", {})).toBe(false);
    expect(
      isOperationAvailable("start_conformance_run", { conformance: false })
    ).toBe(false);
    expect(
      isOperationAvailable("start_conformance_run", {
        conformance: "yes" as unknown as boolean,
      })
    ).toBe(false);
    expect(
      isOperationAvailable("start_conformance_run", { conformance: true })
    ).toBe(true);
    // Inherited properties are not reported features.
    expect(
      isOperationAvailable(
        "start_conformance_run",
        Object.create({ conformance: true }) as Record<string, boolean>
      )
    ).toBe(false);
  });

  it("makes a multi-feature operation available when any feature is", () => {
    expect(isOperationAvailable("rotate_share_link", {})).toBe(false);
    expect(isOperationAvailable("rotate_share_link", { sandboxes: true })).toBe(
      true
    );
    expect(
      isOperationAvailable("rotate_share_link", {
        "unified-share-evals": true,
      })
    ).toBe(true);
  });

  it("never hides a way to stop what outlives a feature being turned off", () => {
    // Each stops, takes down or cleans up something that can outlive an
    // organization losing the feature, or reads what to act on. The backend
    // leaves them open for exactly that case.
    for (const name of [
      "set_eval_suite_schedule",
      "list_trace_destinations",
      "get_trace_destination",
      "pause_trace_destination",
      "delete_trace_destination",
      "list_goal_runs",
      "get_goal_run",
      "cancel_goal_run",
      "cancel_journey_run",
      "list_studies",
      "get_study",
      "unpublish_study",
      "unpublish_scenario",
      "update_study",
      "update_user_testing_scenario",
      "remove_study_member",
      "rotate_study_link",
      "set_study_guest_execution",
      "get_share_settings",
      "set_share_mode",
      "list_readiness_runs",
      "get_readiness_run",
      "cancel_readiness_run",
      "cancel_swarm_run_insights",
      "cancel_study_insights",
      "get_study_signals",
      "get_user_testing_signals",
      "list_personas",
      "delete_persona",
      "list_goals",
      "archive_goal",
      "archive_journey",
      "list_swarms",
      "archive_swarm",
      "list_sandbox_images",
      "delete_sandbox_image",
      "archive_project_environment",
    ]) {
      expect(isOperationAvailable(name, {}), name).toBe(true);
    }
    // Their counterparts that start or widen something are still gated.
    for (const name of [
      "create_trace_destination",
      "resume_trace_destination",
      "launch_goal_run",
      "publish_study",
      "upsert_study_member",
      "rotate_share_link",
      "start_claude_readiness_run",
      "request_swarm_run_insights",
      "create_persona",
      "create_goal",
      "create_swarm",
      "create_sandbox_image",
      "restore_project_environment",
    ]) {
      expect(isOperationAvailable(name, {}), name).toBe(false);
    }
  });

  it("treats an operation it does not know as unavailable", () => {
    expect(isOperationAvailable("not_an_operation", {})).toBe(false);
  });
});

describe("disabledOperations", () => {
  const allOn = Object.fromEntries(
    PLATFORM_FEATURE_KEYS.map((key) => [key, true])
  ) as Record<PlatformFeatureKey, boolean>;

  it("disables nothing when every feature is on", () => {
    expect(disabledOperations(allOn)).toEqual([]);
  });

  it("disables every gated operation, and only those, when none is", () => {
    const disabled = new Set(disabledOperations({}));
    for (const [name, feature] of Object.entries(OPERATION_FEATURES)) {
      expect(disabled.has(name), name).toBe(feature !== null);
    }
  });

  it("disables exactly one feature's operations when only it is off", () => {
    const disabled = disabledOperations({ ...allOn, "hosted-browser": false });
    expect(disabled.sort()).toEqual(
      ["drive_chat_session_browser", "observe_chat_session_browser"].sort()
    );
  });

  it("keeps sandbox images apart from the computer itself", () => {
    expect(
      disabledOperations({ ...allOn, "sandbox-images": false }).sort()
    ).toEqual(
      [
        "build_sandbox_image",
        "create_sandbox_image",
        "list_sandbox_image_builds",
        "promote_sandbox_image",
        "update_sandbox_image",
        "use_sandbox_image",
        "validate_sandbox_image_blueprint",
      ].sort()
    );
    expect(disabledOperations({ ...allOn, computers: false })).toEqual([
      "reset_computer",
    ]);
  });
});

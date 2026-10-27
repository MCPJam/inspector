import { describe, expect, it } from "vitest";
import { validateToolPolicyNames } from "@mcpjam/sdk/contract";
import { deferredViewToolPolicyNames } from "../view-tool-policy-name.js";

describe("deferred view policy names", () => {
  it("defers a qualified view deny with a visible warning", () => {
    const policy = { mode: "default" as const, deny: ["view:make_move"] };
    expect(validateToolPolicyNames({
      policy,
      availableToolNames: ["delete_file"],
      deferredToolNames: deferredViewToolPolicyNames(policy),
    })).toEqual([
      "Tool policy deny name(s) could not be resolved at run start: view:make_move",
    ]);
  });

  it.each(["delte_file", "make_move", "view:", "veiw:make_move"])(
    "does not exempt unmatched %s from validation",
    (name) => {
      const policy = { mode: "default" as const, deny: ["view:make_move", name] };
      expect(() => validateToolPolicyNames({
        policy,
        availableToolNames: ["delete_file"],
        deferredToolNames: deferredViewToolPolicyNames(policy),
      })).toThrow("TOOL_POLICY_INVALID");
    },
  );
});

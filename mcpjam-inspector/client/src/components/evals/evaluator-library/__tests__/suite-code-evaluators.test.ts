import { describe, expect, it, vi } from "vitest";
import { codeGradingGate } from "../../code-grading/code-grading-flags";
import {
  initSuiteSettingsDraft,
  readSuiteSettingsValues,
} from "../../suite-settings-draft";
import type { CodeEvaluator } from "../code-evaluator-model";
import {
  CODE_EVALUATORS_NEED_GRADING_COPY,
  codeEvaluatorRunRefusal,
  codeMethodAvailability,
  requiredRoleRefusal,
  suiteCodeEvaluators,
  suiteGradingMode,
  type SuiteCodeEvaluators,
} from "../suite-code-evaluators";

const ON = codeGradingGate(true, { enabled: true });
const evaluator = (patch: Partial<CodeEvaluator> = {}): CodeEvaluator => ({
  id: "check",
  name: "Check",
  fileName: "check.py",
  script: "print(1)",
  role: "advisory",
  ...patch,
});

function code(patch: Partial<SuiteCodeEvaluators> = {}): SuiteCodeEvaluators {
  return {
    evaluators: [],
    onChange: vi.fn(),
    gate: ON,
    gradingMode: "enforce",
    scripts: undefined,
    ...patch,
  };
}

describe("suiteGradingMode", () => {
  it("reads an absent or unknown mode as off", () => {
    expect(suiteGradingMode({})).toBe("off");
    expect(suiteGradingMode({ gradingEngine: { mode: "turbo" } })).toBe("off");
  });

  it("counts enforce only on a suite under verdict policy v2", () => {
    expect(
      suiteGradingMode({
        gradingEngine: { mode: "enforce" },
        verdictPolicyVersion: 2,
      }),
    ).toBe("enforce");
    // Run start lowers a legacy suite's enforce to dual_write.
    expect(suiteGradingMode({ gradingEngine: { mode: "enforce" } })).toBe(
      "dual_write",
    );
    expect(suiteGradingMode({ gradingEngine: { mode: "shadow" } })).toBe(
      "shadow",
    );
  });
});

describe("the Code card", () => {
  it("is left out while the eval-code-evaluators flag is off or loading", () => {
    expect(
      codeMethodAvailability(code({ gate: codeGradingGate(false, undefined) })),
    ).toBeUndefined();
    expect(
      codeMethodAvailability(
        code({ gate: codeGradingGate(undefined, undefined) }),
      ),
    ).toBeUndefined();
  });

  it("says why when the suite's capabilities refuse it", () => {
    expect(
      codeMethodAvailability(
        code({
          gate: codeGradingGate(true, { enabled: false, reason: "flag_false" }),
        }),
      ),
    ).toBe("Not enabled for this organization.");
  });

  it("is off below dual_write, where runs refuse any code evaluator", () => {
    expect(codeMethodAvailability(code({ gradingMode: "off" }))).toBe(
      CODE_EVALUATORS_NEED_GRADING_COPY,
    );
    expect(codeMethodAvailability(code({ gradingMode: "shadow" }))).toBe(
      CODE_EVALUATORS_NEED_GRADING_COPY,
    );
    expect(codeMethodAvailability(code({ gradingMode: "dual_write" }))).toBe(
      null,
    );
  });

  it("is off at the suite's limit of ten", () => {
    const full = Array.from({ length: 10 }, (_, n) =>
      evaluator({ id: `check-${n}` }),
    );
    expect(codeMethodAvailability(code({ evaluators: full }))).toBe(
      "Remove a code evaluator to add another. Each suite can have 10 code evaluators.",
    );
  });
});

describe("Required", () => {
  it("is offered only at enforce, with the reason otherwise", () => {
    expect(requiredRoleRefusal("enforce")).toBeUndefined();
    expect(requiredRoleRefusal("dual_write")).toBe(
      "Required needs this suite's grading set to Enforce. Until it is, this evaluator can only be Advisory.",
    );
  });
});

describe("codeEvaluatorRunRefusal", () => {
  it("says why runs won't start with the evaluators a suite holds", () => {
    expect(
      codeEvaluatorRunRefusal({ evaluators: [], gradingMode: "off" }),
    ).toBe(undefined);
    expect(
      codeEvaluatorRunRefusal({
        evaluators: [evaluator()],
        gradingMode: "off",
      }),
    ).toMatch(/won't start while it has code evaluators/);
    expect(
      codeEvaluatorRunRefusal({
        evaluators: [evaluator({ role: "required" })],
        gradingMode: "dual_write",
      }),
    ).toMatch(/Make it Advisory to run the suite/);
    expect(
      codeEvaluatorRunRefusal({
        evaluators: [evaluator({ role: "required" })],
        gradingMode: "enforce",
      }),
    ).toBeUndefined();
  });
});

describe("suiteCodeEvaluators", () => {
  const draftFor = (grading?: { network: "web" }) =>
    initSuiteSettingsDraft({
      suiteId: "suite-1",
      values: readSuiteSettingsValues({
        codeEvaluators: [evaluator()],
        ...(grading ? { grading } : {}),
      }),
    });

  it("tests on the suite's project with the network the draft would save", () => {
    const code = suiteCodeEvaluators({
      suite: { _id: "suite-1", projectId: "project-1" },
      draft: draftFor({ network: "web" }),
      dispatch: vi.fn(),
      gate: ON,
    });
    expect(code.evaluators).toEqual([evaluator()]);
    expect(code.test).toEqual({
      projectId: "project-1",
      suiteId: "suite-1",
      network: "web",
    });
    expect(
      suiteCodeEvaluators({
        suite: { _id: "suite-1" },
        draft: draftFor(),
        dispatch: vi.fn(),
        gate: ON,
      }).test,
    ).toBeUndefined();
  });

  it("writes an emptied list as none", () => {
    const dispatch = vi.fn();
    const code = suiteCodeEvaluators({
      suite: { _id: "suite-1" },
      draft: draftFor(),
      dispatch,
      gate: ON,
    });
    code.onChange([]);
    expect(dispatch).toHaveBeenCalledWith({
      type: "edit",
      key: "codeEvaluators",
      value: undefined,
    });
  });
});

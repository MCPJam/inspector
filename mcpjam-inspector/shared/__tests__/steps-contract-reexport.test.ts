/**
 * `shared/steps` RE-EXPORTS the canonical step union; it does not copy it.
 *
 * The distinction is the whole point of the relocation. A hand-mirrored copy in
 * this repo would drift from `@mcpjam/sdk/contract` silently — the two would
 * accept slightly different payloads and every parity fixture between them
 * would certify two validators that disagree. Referential equality (`===`) is
 * the only assertion that can tell a re-export from a faithful copy: a copy
 * that happens to be structurally identical today would pass a deep-equal
 * check and fail this one.
 *
 * Same argument for the two caps modules: `shared/scripted-steps` and
 * `shared/probe-config` re-export the constants the SDK's `toolCall` and
 * `interact` steps enforce, so a cap can never be tightened on one side only.
 */

import { describe, expect, it } from "vitest";
import * as contract from "@mcpjam/sdk/contract";
import * as sharedSteps from "../steps";
import * as sharedScriptedSteps from "../scripted-steps";
import * as sharedProbeConfig from "../probe-config";

describe("shared/steps re-exports the SDK contract", () => {
  const schemas = [
    "testStepSchema",
    "stepsSchema",
    "promptStepSchema",
    "toolCallStepSchema",
    "interactStepSchema",
    "assertStepSchema",
    "interactActionSchema",
    "widgetAssertionSchema",
    "stepAssertionPayloadSchema",
  ] as const;

  for (const name of schemas) {
    it(`${name} is the SAME object as the contract's`, () => {
      expect(sharedSteps[name]).toBe(contract[name]);
    });
  }

  const helpers = [
    "isPromptStep",
    "isToolCallStep",
    "isInteractStep",
    "isAssertStep",
    "isWidgetAssertion",
  ] as const;

  for (const name of helpers) {
    it(`${name} is the SAME function as the contract's`, () => {
      expect(sharedSteps[name]).toBe(contract[name]);
    });
  }

  it("TEST_STEP_KINDS and MAX_TEST_STEPS come from the contract", () => {
    expect(sharedSteps.TEST_STEP_KINDS).toBe(contract.TEST_STEP_KINDS);
    expect(sharedSteps.MAX_TEST_STEPS).toBe(contract.MAX_TEST_STEPS);
  });

  it("keeps the UI labels here — presentation is not contract", () => {
    // `WIDGET_ASSERTION_LABELS` deliberately did NOT move: it is display copy,
    // and the SDK has no business shipping this app's wording. It still lives
    // beside the re-exported union so the exhaustive `Record` forces a label
    // for any new assertion kind.
    expect(sharedSteps.WIDGET_ASSERTION_LABELS).toBeDefined();
    expect(contract).not.toHaveProperty("WIDGET_ASSERTION_LABELS");
    expect(Object.keys(sharedSteps.WIDGET_ASSERTION_LABELS).sort()).toEqual(
      [
        "elementHidden",
        "elementVisible",
        "inputValue",
        "textVisible",
        "widgetToolCalled",
      ].sort()
    );
  });
});

describe("shared/scripted-steps re-exports the locator and its caps", () => {
  it("elementLocatorSchema is the SAME object as the contract's", () => {
    expect(sharedScriptedSteps.elementLocatorSchema).toBe(
      contract.elementLocatorSchema
    );
  });

  it("the text and wait caps come from the contract", () => {
    expect(sharedScriptedSteps.MAX_SCRIPTED_STEP_TEXT_CHARS).toBe(
      contract.MAX_SCRIPTED_STEP_TEXT_CHARS
    );
    expect(sharedScriptedSteps.MAX_SCRIPTED_WAIT_MS).toBe(
      contract.MAX_SCRIPTED_WAIT_MS
    );
  });

  it("still owns the scripted-step schemas the SDK does not need", () => {
    // Only what the suite-file contract reuses moved. The legacy per-turn
    // `widgetChecks` shapes stay in this app.
    expect(sharedScriptedSteps.scriptedStepSchema).toBeDefined();
    expect(sharedScriptedSteps.widgetChecksSchema).toBeDefined();
    expect(contract).not.toHaveProperty("scriptedStepSchema");
  });
});

describe("shared/probe-config re-exports the tool-call caps", () => {
  it("both caps come from the contract", () => {
    expect(sharedProbeConfig.MAX_PROBE_ARGS_CHARS).toBe(
      contract.MAX_PROBE_ARGS_CHARS
    );
    expect(sharedProbeConfig.MAX_PROBE_RENDER_TIMEOUT_MS).toBe(
      contract.MAX_PROBE_RENDER_TIMEOUT_MS
    );
  });

  it("still owns probeConfigSchema — the legacy row shape is not contract", () => {
    expect(sharedProbeConfig.probeConfigSchema).toBeDefined();
    expect(contract).not.toHaveProperty("probeConfigSchema");
  });
});

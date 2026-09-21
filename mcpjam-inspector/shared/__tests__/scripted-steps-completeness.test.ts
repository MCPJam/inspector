import { describe, expect, it } from "vitest";
import {
  isLocatorComplete,
  isStepComplete,
  sanitizeWidgetChecks,
  type ScriptedStep,
  type ScriptedWidgetCheck,
} from "../scripted-steps";

// Stored blobs are cast to the step types, never parsed, so a leaf the type
// promises can arrive missing or non-string. The completeness checks run at
// save time on exactly those blobs — they must judge, not throw.
const malformed = <T>(value: unknown): T => value as T;

describe("isLocatorComplete", () => {
  it("accepts any single filled reference point", () => {
    expect(isLocatorComplete({ testId: "add-to-cart" })).toBe(true);
    expect(isLocatorComplete({ role: { role: "button" } })).toBe(true);
    expect(isLocatorComplete({ text: "Save" })).toBe(true);
    expect(isLocatorComplete({ css: ".btn" })).toBe(true);
  });

  it("rejects a missing, empty, or whitespace-only locator", () => {
    expect(isLocatorComplete(undefined)).toBe(false);
    expect(isLocatorComplete({})).toBe(false);
    expect(isLocatorComplete({ testId: "" })).toBe(false);
    expect(isLocatorComplete({ testId: "   " })).toBe(false);
    expect(isLocatorComplete({ role: { role: "  " } })).toBe(false);
  });

  it("rejects non-string leaves without throwing", () => {
    expect(isLocatorComplete(malformed({ testId: null }))).toBe(false);
    expect(isLocatorComplete(malformed({ css: 42 }))).toBe(false);
    expect(isLocatorComplete(malformed({ role: { role: undefined } }))).toBe(
      false,
    );
  });
});

describe("isStepComplete", () => {
  it("judges filled steps complete", () => {
    expect(isStepComplete({ kind: "click", target: { testId: "a" } })).toBe(
      true,
    );
    expect(isStepComplete({ kind: "key", key: "Enter" })).toBe(true);
    expect(isStepComplete({ kind: "wait", ms: 100 })).toBe(true);
    expect(
      isStepComplete({
        kind: "assert",
        assertion: { type: "textVisible", text: "Saved" },
      }),
    ).toBe(true);
    expect(
      isStepComplete({
        kind: "assert",
        assertion: { type: "widgetToolCalled", toolName: "create_view" },
      }),
    ).toBe(true);
  });

  it("rejects whitespace-only and non-string fields without throwing", () => {
    expect(isStepComplete({ kind: "key", key: "   " })).toBe(false);
    expect(isStepComplete(malformed<ScriptedStep>({ kind: "key" }))).toBe(false);
    expect(
      isStepComplete({
        kind: "assert",
        assertion: { type: "textVisible", text: "  " },
      }),
    ).toBe(false);
    expect(
      isStepComplete(
        malformed<ScriptedStep>({
          kind: "assert",
          assertion: { type: "widgetToolCalled", toolName: null },
        }),
      ),
    ).toBe(false);
    expect(
      isStepComplete(malformed<ScriptedStep>({ kind: "click", target: null })),
    ).toBe(false);
  });
});

describe("sanitizeWidgetChecks", () => {
  it("keeps complete steps and drops half-authored ones", () => {
    expect(
      sanitizeWidgetChecks([
        {
          toolName: "create_view",
          steps: [
            { kind: "click", target: { testId: "a" } },
            { kind: "click", target: { testId: " " } },
          ],
        },
      ]),
    ).toEqual([
      { toolName: "create_view", steps: [{ kind: "click", target: { testId: "a" } }] },
    ]);
  });

  it("drops groups whose toolName is whitespace-only or not a string", () => {
    const steps: ScriptedStep[] = [{ kind: "click", target: { testId: "a" } }];
    expect(sanitizeWidgetChecks([{ toolName: "  ", steps }])).toBeUndefined();
    expect(
      sanitizeWidgetChecks([
        malformed<ScriptedWidgetCheck>({ toolName: undefined, steps }),
      ]),
    ).toBeUndefined();
  });
});

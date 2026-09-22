import { describe, expect, it } from "vitest";

import { annotateStepsWithAttachments } from "../../evals-runner";
import type { TestStep } from "@/shared/steps";

/**
 * Where the attachment note has to land to be read.
 *
 * `seedAndAnnotateEvalAttachments` applies it to `promptTurns`, which is NOT
 * what the model sees: both runners drive the iteration through
 * `executeSteps`, whose steps come from `resolveSteps(test)` — and that
 * returns `test.steps` verbatim whenever the case carries them. So a case
 * authored in the step model had its files seeded onto the box with nothing
 * anywhere telling the model where they were.
 */
describe("annotateStepsWithAttachments", () => {
  const prompt = (id: string, text: string): TestStep => ({
    id,
    kind: "prompt",
    prompt: text,
  });
  const NOTE = "[Attachments uploaded to the computer]\n- a.csv: /x/a.csv";

  it("appends the note to the FIRST prompt step", () => {
    const steps = [prompt("s1", "first"), prompt("s2", "second")];
    const out = annotateStepsWithAttachments(steps, NOTE);
    expect(out[0]).toMatchObject({ id: "s1", prompt: `first\n\n${NOTE}` });
    // Only the first: the note describes the box, not each turn.
    expect(out[1]).toMatchObject({ id: "s2", prompt: "second" });
  });

  it("does not mutate the case's own steps", () => {
    // Steps are persisted and replayed; writing the note into them would store
    // a path from one iteration's box in the case itself.
    const steps = [prompt("s1", "first")];
    const out = annotateStepsWithAttachments(steps, NOTE);
    expect(steps[0]!.prompt).toBe("first");
    expect(out).not.toBe(steps);
  });

  it("is a no-op with no note, and with no prompt step to carry it", () => {
    const steps = [prompt("s1", "first")];
    expect(annotateStepsWithAttachments(steps, null)).toBe(steps);

    // A pinned-only case runs no model turn, so there is nothing to tell.
    const pinnedOnly: TestStep[] = [
      { id: "t1", kind: "toolCall", toolName: "x", arguments: {} } as TestStep,
    ];
    expect(annotateStepsWithAttachments(pinnedOnly, NOTE)).toBe(pinnedOnly);
  });
});

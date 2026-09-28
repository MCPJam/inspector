/**
 * What an author READS when a box could not be provisioned.
 *
 * An eval surface has no separate notice channel — a failed setup IS the
 * message — so the wording carries the whole story, and these pin the two
 * cases where a raw status would tell nobody anything:
 *
 *   - the DESKTOP refusals arrive as a sentence written for a human. They are
 *     terminal for the run and name the fix, so they pass through verbatim.
 *   - CAPACITY is a WAIT, not a mistake, and WHICH budget was hit decides what
 *     the author does about it.
 */
import { describe, expect, it } from "vitest";

import { describeEvalSandboxRefusal } from "../../evals-runner";

describe("describeEvalSandboxRefusal", () => {
  it("passes a desktop_pin_conflict through verbatim", () => {
    // The decision that most fights "your snapshot plus a browser", so the
    // message must survive: wrapping it in "Could not provision the eval's
    // reproducible sandbox: <409>" would bury the only actionable half.
    const message =
      "This eval run pins a custom computer environment AND advertises the " +
      "browser tool. Browsers run on the stock desktop image today, so a run " +
      "cannot have both — remove the environment pin, or drop the browser " +
      "tool from this host config.";
    expect(
      describeEvalSandboxRefusal({
        status: 409,
        code: "desktop_pin_conflict",
        error: message,
      }),
    ).toBe(message);
  });

  it("passes the other terminal desktop refusals through too", () => {
    for (const code of [
      "desktop_not_advertised",
      "desktop_unavailable",
      "runtime_kind_mismatch",
    ]) {
      expect(
        describeEvalSandboxRefusal({ status: 409, code, error: "the reason" }),
      ).toBe("the reason");
    }
  });

  it("names DESKTOP capacity as a wait, distinctly from any other capacity", () => {
    // A desktop wait is a different sentence — and a different remedy — from
    // "this deployment is full", and a bare 503 reads as a stall.
    expect(
      describeEvalSandboxRefusal({
        status: 503,
        code: "at_capacity",
        resource: "desktop",
        error:
          "This organization already has 4 desktop (browser) sandboxes in flight.",
      }),
    ).toMatch(/^Waiting on desktop \(browser\) capacity/);

    expect(
      describeEvalSandboxRefusal({
        status: 503,
        code: "at_capacity",
        resource: "global",
        error: "Computers is at capacity, try again in a few minutes",
      }),
    ).toMatch(/^Waiting on sandbox capacity/);
  });

  it("keeps the old wording for every other failure", () => {
    // Behaviour-preserving for the pinned-environment and harness paths, which
    // are the entire existing population.
    expect(
      describeEvalSandboxRefusal({
        status: 400,
        code: "builder_incompatible",
        error: "set COMPUTERS_ENV_BUILDER=e2b",
      }),
    ).toBe(
      "Could not provision the eval's reproducible sandbox: set COMPUTERS_ENV_BUILDER=e2b",
    );
  });
});

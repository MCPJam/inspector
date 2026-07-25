import { describe, expect, it } from "vitest";
import { narrowElicitationToLocalSupport } from "../elicitation.js";

/**
 * The local SSE bridge is form-only. These lock "advertise = enforce" on that
 * path: whatever goes on the wire must be something the bridge can complete.
 */
describe("narrowElicitationToLocalSupport", () => {
  it("strips url while keeping form", () => {
    // The host toggle can write {form,url}. Local must not claim url: the SDK
    // would accept the request and the bridge would drop the URL, leaving a
    // form the user cannot complete.
    expect(
      narrowElicitationToLocalSupport({
        roots: {},
        elicitation: { form: {}, url: {} },
      }),
    ).toEqual({ roots: {}, elicitation: { form: {} } });
  });

  it("drops the capability entirely when only url was declared", () => {
    // Narrowing {url:{}} to {} would silently mean "form" — a capability the
    // caller never asked for. Claiming nothing is the honest outcome.
    expect(
      narrowElicitationToLocalSupport({ roots: {}, elicitation: { url: {} } }),
    ).toEqual({ roots: {} });
  });

  it("leaves bare {} untouched", () => {
    // Already form-only per the spec's back-compat rule; rewriting it would
    // churn configs for no behavior change.
    const caps = { elicitation: {} };
    expect(narrowElicitationToLocalSupport(caps)).toBe(caps);
  });

  it("leaves form-only declarations untouched in value", () => {
    expect(narrowElicitationToLocalSupport({ elicitation: { form: {} } })).toEqual(
      { elicitation: { form: {} } },
    );
  });

  it("preserves unrelated capabilities and unknown elicitation sub-keys are dropped", () => {
    // Unknown modes are, by definition, modes this bridge cannot complete.
    expect(
      narrowElicitationToLocalSupport({
        sampling: {},
        elicitation: { form: {}, telepathy: {} },
      }),
    ).toEqual({ sampling: {}, elicitation: { form: {} } });
  });

  it.each([
    [undefined],
    [{}],
    [{ roots: {} }],
    [{ elicitation: true }],
    [{ elicitation: "yes" }],
    [{ elicitation: [] }],
  ])("passes through non-object / absent elicitation: %p", (caps) => {
    expect(narrowElicitationToLocalSupport(caps as any)).toBe(caps);
  });

  it("does not mutate the input", () => {
    const caps = { elicitation: { form: {}, url: {} } };
    narrowElicitationToLocalSupport(caps);
    expect(caps).toEqual({ elicitation: { form: {}, url: {} } });
  });
});

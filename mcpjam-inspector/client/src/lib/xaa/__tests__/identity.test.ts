import { describe, expect, it } from "vitest";
import {
  XAA_DEMO_IDENTITY,
  XAA_PARTIAL_OVERRIDE_ERROR,
  isCompleteIdentityPair,
  resolveXaaIdentitySaveFields,
  resolveXaaTestIdentity,
} from "../identity";

const person = { subject: "bob-001", email: "bob@tables.test" };
const override = { subject: "server-sub", email: "server@example.com" };
const projectDefault = { subject: "proj-sub-1", email: "proj@example.com" };
const runFallback = XAA_DEMO_IDENTITY;

describe("resolveXaaTestIdentity — atomic precedence matrix", () => {
  it("selected person wins over everything, both fields together", () => {
    const result = resolveXaaTestIdentity({
      selectedPerson: person,
      serverOverride: override,
      projectDefault,
      runFallback,
    });
    expect(result).toEqual({
      ok: true,
      identity: person,
      source: "person",
    });
  });

  it("complete server override wins over project default and fallback", () => {
    const result = resolveXaaTestIdentity({
      selectedPerson: null,
      serverOverride: override,
      projectDefault,
      runFallback,
    });
    expect(result).toEqual({
      ok: true,
      identity: override,
      source: "server_override",
    });
  });

  it("project default wins over the run fallback when no override exists", () => {
    const result = resolveXaaTestIdentity({
      selectedPerson: null,
      serverOverride: { subject: "", email: "" },
      projectDefault,
      runFallback,
    });
    expect(result).toEqual({
      ok: true,
      identity: projectDefault,
      source: "project_default",
    });
  });

  it("falls back to run settings when nothing else is configured", () => {
    const result = resolveXaaTestIdentity({
      selectedPerson: null,
      serverOverride: null,
      projectDefault: null,
      runFallback,
    });
    expect(result).toEqual({
      ok: true,
      identity: runFallback,
      source: "run_fallback",
    });
  });

  it("a registration target (no server override) resolves person > project default > fallback", () => {
    expect(
      resolveXaaTestIdentity({
        selectedPerson: person,
        serverOverride: null,
        projectDefault,
        runFallback,
      }),
    ).toMatchObject({ ok: true, source: "person" });
    expect(
      resolveXaaTestIdentity({
        selectedPerson: null,
        serverOverride: null,
        projectDefault,
        runFallback,
      }),
    ).toMatchObject({ ok: true, source: "project_default" });
    expect(
      resolveXaaTestIdentity({
        selectedPerson: null,
        serverOverride: null,
        projectDefault: null,
        runFallback,
      }),
    ).toMatchObject({ ok: true, source: "run_fallback" });
  });

  it("a partial legacy server override is a blocking error, never a mixed identity", () => {
    for (const partial of [
      { subject: "only-sub", email: "" },
      { subject: "only-sub", email: undefined },
      { subject: "", email: "only@example.com" },
      { subject: "   ", email: "only@example.com" },
    ]) {
      const result = resolveXaaTestIdentity({
        selectedPerson: null,
        serverOverride: partial,
        projectDefault,
        runFallback,
      });
      expect(result).toEqual({ ok: false, error: XAA_PARTIAL_OVERRIDE_ERROR });
    }
  });

  it("a selected person bypasses the partial-override error (person is atomic and wins)", () => {
    const result = resolveXaaTestIdentity({
      selectedPerson: person,
      serverOverride: { subject: "only-sub", email: "" },
      projectDefault: null,
      runFallback,
    });
    expect(result).toMatchObject({ ok: true, source: "person" });
  });

  it("treats a partial project default as absent — never mixes it either", () => {
    const result = resolveXaaTestIdentity({
      selectedPerson: null,
      serverOverride: null,
      projectDefault: { subject: "proj-sub-1", email: "" } as any,
      runFallback,
    });
    expect(result).toEqual({
      ok: true,
      identity: runFallback,
      source: "run_fallback",
    });
  });

  it("blank/whitespace values count as empty everywhere", () => {
    const result = resolveXaaTestIdentity({
      selectedPerson: { subject: "  ", email: "someone@example.com" },
      serverOverride: { subject: " ", email: "  " },
      projectDefault: null,
      runFallback,
    });
    expect(result).toEqual({
      ok: true,
      identity: runFallback,
      source: "run_fallback",
    });
  });
});

describe("isCompleteIdentityPair", () => {
  it("requires both members non-blank", () => {
    expect(isCompleteIdentityPair(projectDefault)).toBe(true);
    expect(isCompleteIdentityPair({ subject: "a", email: "" })).toBe(false);
    expect(isCompleteIdentityPair({ subject: "", email: "b" })).toBe(false);
    expect(isCompleteIdentityPair(null)).toBe(false);
    expect(isCompleteIdentityPair(undefined)).toBe(false);
  });
});

describe("resolveXaaIdentitySaveFields — shared save-path semantics", () => {
  const existing = {
    authServerMode: "mcpjam" as const,
    xaaSubject: "stored-sub",
    xaaEmail: "stored@example.com",
  };

  it("preserves stored values when the form omits the pair (untouched)", () => {
    expect(
      resolveXaaIdentitySaveFields({
        useXaa: true,
        formAuthServerMode: "mcpjam",
        formSubject: undefined,
        formEmail: undefined,
        existing,
      }),
    ).toEqual({
      authServerMode: "mcpjam",
      xaaSubject: "stored-sub",
      xaaEmail: "stored@example.com",
    });
  });

  it("writes the trimmed pair when the form emits a complete edit", () => {
    expect(
      resolveXaaIdentitySaveFields({
        useXaa: true,
        formAuthServerMode: "mcpjam",
        formSubject: "  new-sub  ",
        formEmail: " new@example.com ",
        existing,
      }),
    ).toEqual({
      authServerMode: "mcpjam",
      xaaSubject: "new-sub",
      xaaEmail: "new@example.com",
    });
  });

  it('writes "" for both on an explicit clear so the backend can normalize', () => {
    expect(
      resolveXaaIdentitySaveFields({
        useXaa: true,
        formAuthServerMode: "mcpjam",
        formSubject: "",
        formEmail: "",
        existing,
      }),
    ).toEqual({
      authServerMode: "mcpjam",
      xaaSubject: "",
      xaaEmail: "",
    });
  });

  it("completes a one-sided patch from the stored row so the pair stays atomic", () => {
    expect(
      resolveXaaIdentitySaveFields({
        useXaa: true,
        formSubject: "patched-sub",
        formEmail: undefined,
        existing,
      }),
    ).toEqual({
      authServerMode: "mcpjam",
      xaaSubject: "patched-sub",
      xaaEmail: "stored@example.com",
    });
  });

  it("defaults authServerMode to mcpjam for XAA saves", () => {
    expect(
      resolveXaaIdentitySaveFields({
        useXaa: true,
        formSubject: undefined,
        formEmail: undefined,
        existing: undefined,
      }),
    ).toEqual({
      authServerMode: "mcpjam",
      xaaSubject: undefined,
      xaaEmail: undefined,
    });
  });

  it("preserves everything untouched for non-XAA saves", () => {
    expect(
      resolveXaaIdentitySaveFields({
        useXaa: false,
        formSubject: "ignored",
        formEmail: "ignored@example.com",
        existing,
      }),
    ).toEqual(existing);
  });
});

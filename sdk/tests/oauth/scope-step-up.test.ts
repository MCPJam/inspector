import {
  computeScopeUnion,
  parseInsufficientScopeChallenge,
  resolveStepUpAction,
} from "../../src/oauth/state-machines/shared/challenges.js";

describe("computeScopeUnion (SEP-2350)", () => {
  it("preserves previous-first order and de-duplicates", () => {
    expect(computeScopeUnion(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("handles missing sides", () => {
    expect(computeScopeUnion(undefined, ["x"])).toEqual(["x"]);
    expect(computeScopeUnion(["x"], undefined)).toEqual(["x"]);
    expect(computeScopeUnion()).toEqual([]);
  });

  it("trims and drops blank scopes", () => {
    expect(computeScopeUnion([" a ", ""], ["a", "  ", "b"])).toEqual(["a", "b"]);
  });
});

describe("parseInsufficientScopeChallenge (RFC 6750 / SEP-2350)", () => {
  it("extracts challenged scopes and resource metadata", () => {
    const c = parseInsufficientScopeChallenge(
      'Bearer error="insufficient_scope", scope="read write", resource_metadata="https://rs.example.com/.well-known/oauth-protected-resource"',
    );
    expect(c.isInsufficientScope).toBe(true);
    expect(c.challengedScopes).toEqual(["read", "write"]);
    expect(c.resourceMetadata).toBe(
      "https://rs.example.com/.well-known/oauth-protected-resource",
    );
  });

  it("does not treat a plain invalid_token 401 as a scope step-up", () => {
    const c = parseInsufficientScopeChallenge('Bearer error="invalid_token"');
    expect(c.isInsufficientScope).toBe(false);
    expect(c.challengedScopes).toBeUndefined();
  });

  it("returns a benign result for a missing/blank header", () => {
    expect(parseInsufficientScopeChallenge(undefined).isInsufficientScope).toBe(
      false,
    );
    expect(parseInsufficientScopeChallenge("").isInsufficientScope).toBe(false);
  });

  it("finds the Bearer challenge when another scheme is listed first", () => {
    const c = parseInsufficientScopeChallenge(
      'Basic realm="x", Bearer error="insufficient_scope", scope="read write"',
    );
    expect(c.isInsufficientScope).toBe(true);
    expect(c.challengedScopes).toEqual(["read", "write"]);
  });

  it("does not let a LATER scheme's params bleed into the Bearer challenge", () => {
    // The Basic challenge trailing Bearer carries error="insufficient_scope";
    // it must NOT be attributed to Bearer (which here is a plain 401).
    const c = parseInsufficientScopeChallenge(
      'Bearer realm="mcp", Basic error="insufficient_scope", scope="admin"',
    );
    expect(c.isInsufficientScope).toBe(false);
    expect(c.challengedScopes).toBeUndefined();
  });

  it("does not let a later realm-only Bearer hide an earlier insufficient_scope", () => {
    // Reviewer repro: last-Bearer-wins would return isInsufficientScope=false.
    const c = parseInsufficientScopeChallenge(
      'Bearer error="insufficient_scope", scope="admin", Bearer realm="fallback"',
    );
    expect(c.isInsufficientScope).toBe(true);
    expect(c.challengedScopes).toEqual(["admin"]);
  });

  it("is not fooled by a fabricated challenge hidden inside a quoted value", () => {
    // The quoted realm contains a comma and a fake `Bearer error=…`; quote-aware
    // splitting keeps it as one Basic auth-param, so no insufficient_scope.
    const c = parseInsufficientScopeChallenge(
      'Basic realm="x, Bearer error=insufficient_scope"',
    );
    expect(c.isInsufficientScope).toBe(false);
  });
});

describe("resolveStepUpAction (§10.5 policy split, bounded retry)", () => {
  it("interactive reauthorizes up to maxRetries then throws", () => {
    expect(
      resolveStepUpAction({ authMode: "interactive", attempt: 0 }),
    ).toBe("reauthorize");
    // Default maxRetries is 1: after one re-authorization it must stop.
    expect(
      resolveStepUpAction({ authMode: "interactive", attempt: 1 }),
    ).toBe("throw");
  });

  it("honors a higher maxRetries bound", () => {
    expect(
      resolveStepUpAction({ authMode: "interactive", attempt: 1, maxRetries: 2 }),
    ).toBe("reauthorize");
    expect(
      resolveStepUpAction({ authMode: "interactive", attempt: 2, maxRetries: 2 }),
    ).toBe("throw");
  });

  it("stays bounded when given a non-finite maxRetries (Infinity)", () => {
    expect(
      resolveStepUpAction({
        authMode: "interactive",
        attempt: 1,
        maxRetries: Infinity,
      }),
    ).toBe("throw");
    expect(
      resolveStepUpAction({
        authMode: "interactive",
        attempt: 0,
        maxRetries: Infinity,
      }),
    ).toBe("reauthorize");
  });

  it("never opens a browser for M2M", () => {
    expect(resolveStepUpAction({ authMode: "m2m", attempt: 0 })).toBe("throw");
  });

  it("lets the debugger advance manually", () => {
    expect(resolveStepUpAction({ authMode: "debugger", attempt: 0 })).toBe(
      "manual",
    );
    expect(resolveStepUpAction({ authMode: "debugger", attempt: 5 })).toBe(
      "manual",
    );
  });
});

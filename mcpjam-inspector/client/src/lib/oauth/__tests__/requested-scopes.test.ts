import { afterEach, describe, expect, it } from "vitest";
import {
  persistRequestedScopes,
  readRequestedScopes,
  stepUpScopeUnion,
} from "../requested-scopes";

const asA = "https://as-a.example.com";
const asB = "https://as-b.example.com";
const SERVER = "scoped-server";

afterEach(() => {
  localStorage.clear();
});

describe("requested-scopes persistence (2R-stepup, §10.2#4)", () => {
  it("persists and reads scopes for the exact issuer", () => {
    persistRequestedScopes(SERVER, asA, ["read", "write"]);
    expect(readRequestedScopes(SERVER, asA)).toEqual(["read", "write"]);
  });

  it("does not return AS A's scopes for AS B (SEP-2352)", () => {
    persistRequestedScopes(SERVER, asA, ["read"]);
    expect(readRequestedScopes(SERVER, asB)).toBeUndefined();
  });

  it("keeps each issuer's scopes in its own bucket", () => {
    persistRequestedScopes(SERVER, asA, ["read"]);
    persistRequestedScopes(SERVER, asB, ["admin"]);
    expect(readRequestedScopes(SERVER, asA)).toEqual(["read"]);
    expect(readRequestedScopes(SERVER, asB)).toEqual(["admin"]);
  });

  it("normalizes and de-duplicates on write", () => {
    persistRequestedScopes(SERVER, asA, [" read ", "read", "write", ""]);
    expect(readRequestedScopes(SERVER, asA)).toEqual(["read", "write"]);
  });

  it("no-ops for an unknown issuer or empty scopes", () => {
    persistRequestedScopes(SERVER, undefined, ["read"]);
    persistRequestedScopes(SERVER, asA, []);
    expect(readRequestedScopes(SERVER, asA)).toBeUndefined();
  });

  it("unions persisted scopes with a 403 challenge for the step-up request", () => {
    persistRequestedScopes(SERVER, asA, ["read", "write"]);
    expect(stepUpScopeUnion(SERVER, asA, ["write", "admin"])).toEqual([
      "read",
      "write",
      "admin",
    ]);
  });

  it("unions only the challenged scopes when nothing was persisted for the issuer", () => {
    persistRequestedScopes(SERVER, asA, ["read"]);
    // A step-up against a different issuer must not fold in AS A's scopes.
    expect(stepUpScopeUnion(SERVER, asB, ["admin"])).toEqual(["admin"]);
  });
});

import { describe, expect, it } from "vitest";
import { resolveAddServerConfidentialCimdContext } from "../AddServerModal";

describe("AddServerModal confidential CIMD context", () => {
  it("falls back to the active signed-in organization when callers omit context", () => {
    expect(
      resolveAddServerConfidentialCimdContext({
        activeProjectOrganizationId: "org-1",
        hasSignedInUser: true,
      })
    ).toEqual({ organizationId: "org-1", isSignedIn: true });
  });

  it("preserves explicit guest and missing-organization context", () => {
    expect(
      resolveAddServerConfidentialCimdContext({
        organizationId: null,
        isSignedIn: false,
        activeProjectOrganizationId: "stale-org",
        hasSignedInUser: true,
      })
    ).toEqual({ organizationId: null, isSignedIn: false });
  });
});

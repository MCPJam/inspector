import { describe, expect, it } from "vitest";
import { describeGuestAuthorityMismatch } from "../env.js";

const STANDARD = "https://energized-ant-201.convex.site";
const PRIVATE = "https://happy-otter-123.convex.site";

describe("describeGuestAuthorityMismatch", () => {
  it("warns when a developer overlay names a private backend but guests are hosted", () => {
    const warning = describeGuestAuthorityMismatch({
      standardConvexHttpUrl: STANDARD,
      overlayConvexHttpUrl: PRIVATE,
      guestAuthorityKind: "hosted",
    });
    expect(warning).toContain("https://happy-otter-123.convex.site");
    expect(warning).toContain("dev:setup-guest-auth");
    expect(warning).toContain("dev:worktree");
  });

  it("is quiet when the overlay keeps the standard backend", () => {
    expect(
      describeGuestAuthorityMismatch({
        standardConvexHttpUrl: STANDARD,
        overlayConvexHttpUrl: `${STANDARD}/`,
        guestAuthorityKind: "hosted",
      }),
    ).toBeNull();
  });

  it("is quiet when the private backend is its own guest authority", () => {
    expect(
      describeGuestAuthorityMismatch({
        standardConvexHttpUrl: STANDARD,
        overlayConvexHttpUrl: PRIVATE,
        guestAuthorityKind: "backend",
      }),
    ).toBeNull();
  });

  it("is quiet when the authority is unconfigured (that fails on its own) or files are missing", () => {
    expect(
      describeGuestAuthorityMismatch({
        standardConvexHttpUrl: STANDARD,
        overlayConvexHttpUrl: PRIVATE,
        guestAuthorityKind: null,
      }),
    ).toBeNull();
    expect(
      describeGuestAuthorityMismatch({
        standardConvexHttpUrl: undefined,
        overlayConvexHttpUrl: PRIVATE,
        guestAuthorityKind: "hosted",
      }),
    ).toBeNull();
    expect(
      describeGuestAuthorityMismatch({
        standardConvexHttpUrl: STANDARD,
        overlayConvexHttpUrl: "not a url",
        guestAuthorityKind: "hosted",
      }),
    ).toBeNull();
  });
});

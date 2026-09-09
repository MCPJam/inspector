import { describe, expect, it } from "vitest";
import {
  buildProjectPath,
  canonicalizeLegacyProjectTarget,
  hasLegacyProjectQuery,
  isAppRelativeTarget,
  isProjectIdShape,
  isProjectScopedPath,
  parseProjectPath,
  PROJECT_ROUTE_PREFIX,
  readLegacyProjectQuery,
  readProjectPathSegment,
  replaceProjectInPath,
  stripLegacyProjectQuery,
  stripProjectFromPath,
} from "../project-route";

const A = "k5700000000000000000000000a";
const B = "k5700000000000000000000000b";

describe("isProjectIdShape", () => {
  it("accepts a Convex id", () => {
    expect(isProjectIdShape(A)).toBe(true);
  });

  it("rejects the values that must never reach the canonical position", () => {
    // `none` is the local/no-Convex placeholder and a real value of
    // `activeProjectId`; minting `/p/none/...` from it would put a
    // non-project where every URL says the project is.
    expect(isProjectIdShape("none")).toBe(false);
    expect(isProjectIdShape("")).toBe(false);
    expect(isProjectIdShape("short")).toBe(false);
    expect(isProjectIdShape("K5700000000000000000000000A")).toBe(false);
    expect(isProjectIdShape("k57-000000000000000000000")).toBe(false);
    expect(isProjectIdShape(undefined)).toBe(false);
    expect(isProjectIdShape(null)).toBe(false);
    expect(isProjectIdShape(42)).toBe(false);
  });
});

describe("parseProjectPath", () => {
  it("splits a scoped path into project and project-relative path", () => {
    expect(parseProjectPath(`/p/${A}/servers`)).toEqual({
      projectId: A,
      relativePath: "/servers",
    });
    expect(parseProjectPath(`/p/${A}/evals/suite/s1/runs/r1`)).toEqual({
      projectId: A,
      relativePath: "/evals/suite/s1/runs/r1",
    });
  });

  it("treats the bare prefix as project home's parent, not a screen", () => {
    expect(parseProjectPath(`/p/${A}`)).toEqual({
      projectId: A,
      relativePath: "/",
    });
  });

  it("decodes the project segment exactly once", () => {
    expect(parseProjectPath(`/p/${encodeURIComponent(A)}/servers`)).toEqual({
      projectId: A,
      relativePath: "/servers",
    });
  });

  it("returns null for anything that is not a usable project path", () => {
    expect(parseProjectPath("/servers")).toBeNull();
    expect(parseProjectPath("/p")).toBeNull();
    expect(parseProjectPath("/p/")).toBeNull();
    expect(parseProjectPath("/p/none/servers")).toBeNull();
    expect(parseProjectPath("/pp/x/servers")).toBeNull();
    expect(parseProjectPath("")).toBeNull();
  });

  it("ignores a trailing query or hash", () => {
    expect(parseProjectPath(`/p/${A}/servers?x=1#y`)).toEqual({
      projectId: A,
      relativePath: "/servers",
    });
  });

  it("is what isProjectScopedPath answers with", () => {
    expect(isProjectScopedPath(`/p/${A}/servers`)).toBe(true);
    expect(isProjectScopedPath("/p/none/servers")).toBe(false);
  });
});

describe("readProjectPathSegment", () => {
  it("reports a claimed project id even when it is unusable", () => {
    // The route boundary needs "is this URL claiming a project" — a malformed
    // one must render the inaccessible state, never fall through to whatever
    // project was already active.
    expect(readProjectPathSegment("/p/none/servers")).toBe("none");
    expect(readProjectPathSegment("/p/NOT-AN-ID/servers")).toBe("NOT-AN-ID");
    expect(readProjectPathSegment(`/p/${A}/servers`)).toBe(A);
    expect(readProjectPathSegment("/servers")).toBeNull();
  });
});

describe("readProjectPathSegment vs isProjectScopedPath", () => {
  it("answers different questions, and callers must pick the right one", () => {
    // The trap: `/p/none/servers` CLAIMS a project (the router matches
    // `p/:projectId` and the boundary owes the visitor an error) but is not a
    // USABLE project path. A guard that asks "is this scoped?" when it means
    // "does this claim a project?" treats the URL as ordinary — which is how
    // the first-run onboarding redirect came to replace an inaccessible
    // project error with Playground, taking the requested URL with it.
    for (const claimed of ["/p/none/servers", "/p/NOT-AN-ID/evals", "/p/x/"]) {
      expect(readProjectPathSegment(claimed), claimed).not.toBeNull();
      expect(isProjectScopedPath(claimed), claimed).toBe(false);
    }
    // A well-formed id answers yes to both.
    expect(readProjectPathSegment(`/p/${A}/servers`)).toBe(A);
    expect(isProjectScopedPath(`/p/${A}/servers`)).toBe(true);
    // An unscoped path answers no to both.
    expect(readProjectPathSegment("/servers")).toBeNull();
    expect(isProjectScopedPath("/servers")).toBe(false);
  });
});

describe("buildProjectPath", () => {
  it("builds the canonical shape", () => {
    expect(buildProjectPath(A, "/servers")).toBe(`${PROJECT_ROUTE_PREFIX}/${A}/servers`);
    expect(buildProjectPath(A, "servers")).toBe(`/p/${A}/servers`);
  });

  it("sends the project root to project home, not to a bare prefix", () => {
    // The contract both this work and the permalink work build against:
    // project home is `/p/<id>/home`.
    expect(buildProjectPath(A, "/")).toBe(`/p/${A}/home`);
    expect(buildProjectPath(A, "")).toBe(`/p/${A}/home`);
  });

  it("preserves query and hash byte-for-byte", () => {
    expect(buildProjectPath(A, "/evals/suite/s1?view=runs&q=a%20b#case-3")).toBe(
      `/p/${A}/evals/suite/s1?view=runs&q=a%20b#case-3`
    );
  });

  it("does not re-encode an already-encoded resource segment", () => {
    expect(buildProjectPath(A, "/conformance/runs/run%2F1")).toBe(
      `/p/${A}/conformance/runs/run%2F1`
    );
  });

  it("is idempotent — scoped input is re-scoped, never double-prefixed", () => {
    const once = buildProjectPath(A, "/servers");
    expect(buildProjectPath(A, once)).toBe(once);
    expect(buildProjectPath(B, once)).toBe(`/p/${B}/servers`);
  });

  it("returns the logical target unchanged when the id is unusable", () => {
    // A caller that has not resolved a project yet must not be able to mint
    // `/p/none/...`.
    expect(buildProjectPath("none", "/servers")).toBe("/servers");
    expect(buildProjectPath("", "/servers")).toBe("/servers");
  });

  it("refuses to build an off-origin redirect", () => {
    expect(buildProjectPath(A, "https://evil.example/x")).toBe(`/p/${A}/home`);
    expect(buildProjectPath(A, "//evil.example/x")).toBe(`/p/${A}/home`);
    expect(buildProjectPath(A, "javascript:alert(1)")).toBe(`/p/${A}/home`);
    expect(buildProjectPath(A, "/\\evil.example")).toBe(`/p/${A}/home`);
  });
});

describe("replaceProjectInPath / stripProjectFromPath", () => {
  it("round-trips through both directions", () => {
    const scoped = buildProjectPath(A, "/evals/suite/s1?view=runs#case");
    expect(stripProjectFromPath(scoped)).toBe("/evals/suite/s1?view=runs#case");
    expect(replaceProjectInPath(scoped, B)).toBe(
      `/p/${B}/evals/suite/s1?view=runs#case`
    );
    expect(stripProjectFromPath(stripProjectFromPath(scoped))).toBe(
      "/evals/suite/s1?view=runs#case"
    );
  });

  it("leaves an unscoped path alone when stripping", () => {
    expect(stripProjectFromPath("/servers?x=1")).toBe("/servers?x=1");
    expect(stripProjectFromPath("/p/none/servers")).toBe("/p/none/servers");
  });

  it("scopes an unscoped path when replacing", () => {
    expect(replaceProjectInPath("/servers", A)).toBe(`/p/${A}/servers`);
  });
});

describe("legacy ?project= handling", () => {
  it("reads only a usable id", () => {
    expect(readLegacyProjectQuery(`?project=${A}`)).toBe(A);
    expect(readLegacyProjectQuery(`?view=runs&project=${A}#x`.split("#")[0])).toBe(A);
    expect(readLegacyProjectQuery("?project=none")).toBeNull();
    expect(readLegacyProjectQuery("?project=")).toBeNull();
    expect(readLegacyProjectQuery("?other=1")).toBeNull();
  });

  it("sees the field even when the value is unusable", () => {
    // A malformed value still has to be STRIPPED, or it lingers in the
    // address bar and keeps suppressing first-run onboarding.
    expect(hasLegacyProjectQuery("?project=oops")).toBe(true);
    expect(hasLegacyProjectQuery("?other=1")).toBe(false);
  });

  it("removes every occurrence and nothing else", () => {
    expect(stripLegacyProjectQuery(`?project=${A}&project=${B}&view=runs`)).toBe(
      "?view=runs"
    );
    expect(stripLegacyProjectQuery(`?a=1&project=${A}&b=2`)).toBe("?a=1&b=2");
    expect(stripLegacyProjectQuery(`?project=${A}`)).toBe("");
  });

  it("does not re-encode the fields it keeps", () => {
    // URLSearchParams would rewrite `+` and normalize escapes — a visible
    // change to somebody's selection state.
    expect(stripLegacyProjectQuery(`?q=a+b&sel=%7B%22x%22%3A1%7D&project=${A}`)).toBe(
      "?q=a+b&sel=%7B%22x%22%3A1%7D"
    );
  });
});

describe("canonicalizeLegacyProjectTarget", () => {
  it("rewrites the documented example", () => {
    expect(
      canonicalizeLegacyProjectTarget({
        logicalTarget: `/evals/suite/X?project=${A}&view=runs#case`,
        projectId: A,
      })
    ).toBe(`/p/${A}/evals/suite/X?view=runs#case`);
  });

  it("scopes a bare legacy path", () => {
    expect(
      canonicalizeLegacyProjectTarget({ logicalTarget: "/servers", projectId: A })
    ).toBe(`/p/${A}/servers`);
  });

  it("sends the unscoped root to project home", () => {
    expect(
      canonicalizeLegacyProjectTarget({ logicalTarget: "/", projectId: A })
    ).toBe(`/p/${A}/home`);
  });

  it("is a no-op on its own output", () => {
    const once = canonicalizeLegacyProjectTarget({
      logicalTarget: `/evals/suite/X?project=${A}&view=runs#case`,
      projectId: A,
    });
    expect(
      canonicalizeLegacyProjectTarget({ logicalTarget: once, projectId: A })
    ).toBe(once);
  });

  it("leaves an already-scoped path on ITS project", () => {
    // Re-scoping here would rewrite a canonical URL to the viewer's default
    // and turn any accidental second pass into a redirect loop.
    expect(
      canonicalizeLegacyProjectTarget({
        logicalTarget: `/p/${B}/evals/suite/X?view=runs`,
        projectId: A,
      })
    ).toBe(`/p/${B}/evals/suite/X?view=runs`);
  });

  it("keeps a hash containing a question mark intact", () => {
    expect(
      canonicalizeLegacyProjectTarget({
        logicalTarget: `/servers?project=${A}#a?b=c`,
        projectId: A,
      })
    ).toBe(`/p/${A}/servers#a?b=c`);
  });

  it("never produces an external target", () => {
    expect(
      canonicalizeLegacyProjectTarget({
        logicalTarget: "https://evil.example/servers",
        projectId: A,
      })
    ).toBe(`/p/${A}/home`);
  });
});

describe("isAppRelativeTarget", () => {
  it("accepts app paths and refuses anything that can leave the origin", () => {
    expect(isAppRelativeTarget("/servers")).toBe(true);
    expect(isAppRelativeTarget("servers")).toBe(true);
    expect(isAppRelativeTarget("https://evil.example")).toBe(false);
    expect(isAppRelativeTarget("//evil.example")).toBe(false);
    expect(isAppRelativeTarget("javascript:alert(1)")).toBe(false);
    expect(isAppRelativeTarget("/\\evil.example")).toBe(false);
    expect(isAppRelativeTarget("")).toBe(false);
  });
});

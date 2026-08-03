import { describe, expect, it } from "vitest";
import {
  hasProjectDeepLinkParam,
  readProjectDeepLinkParam,
  resolveProjectDeepLinkAction,
} from "../project-deep-link";

const PROJECT_ID = "y976c61ap6w524jsrcgx8s4pkx88acvr";
const OTHER_ID = "n170njxr45myj755fc3d5cbe5n8brrgj";

describe("readProjectDeepLinkParam", () => {
  it("reads a well-formed id", () => {
    expect(readProjectDeepLinkParam(`?project=${PROJECT_ID}`)).toBe(
      PROJECT_ID
    );
  });

  it("tolerates a missing leading question mark", () => {
    expect(readProjectDeepLinkParam(`project=${PROJECT_ID}`)).toBe(PROJECT_ID);
  });

  it("ignores other params and absence", () => {
    expect(readProjectDeepLinkParam("?plan=team")).toBeNull();
    expect(readProjectDeepLinkParam("")).toBeNull();
  });

  it("rejects values that don't look like Convex ids", () => {
    expect(readProjectDeepLinkParam("?project=")).toBeNull();
    expect(readProjectDeepLinkParam("?project=UPPER")).toBeNull();
    expect(readProjectDeepLinkParam("?project=short")).toBeNull();
    expect(
      readProjectDeepLinkParam(`?project=${"a".repeat(80)}`)
    ).toBeNull();
    expect(
      readProjectDeepLinkParam("?project=../../evil%20path")
    ).toBeNull();
  });

  it("hasProjectDeepLinkParam mirrors the validated read", () => {
    expect(hasProjectDeepLinkParam(`?project=${PROJECT_ID}`)).toBe(true);
    expect(hasProjectDeepLinkParam("?project=bogus!")).toBe(false);
  });
});

describe("resolveProjectDeepLinkAction", () => {
  const base = {
    requestedProjectId: PROJECT_ID,
    activeProjectId: OTHER_ID,
    activeOrgProjectIds: new Set<string>(),
    allProjects: [] as Array<{ _id: string; organizationId?: string }>,
    activeOrganizationId: "org_a",
  };

  it("clears when already on the requested project", () => {
    expect(
      resolveProjectDeepLinkAction({ ...base, activeProjectId: PROJECT_ID })
    ).toEqual({ kind: "clear" });
  });

  it("switches when the project is visible under the active org", () => {
    expect(
      resolveProjectDeepLinkAction({
        ...base,
        activeOrgProjectIds: new Set([PROJECT_ID]),
      })
    ).toEqual({ kind: "switch-project" });
  });

  it("waits while the membership list is still loading", () => {
    expect(
      resolveProjectDeepLinkAction({ ...base, allProjects: undefined })
    ).toEqual({ kind: "wait" });
  });

  it("switches organization first for a cross-org link", () => {
    expect(
      resolveProjectDeepLinkAction({
        ...base,
        allProjects: [{ _id: PROJECT_ID, organizationId: "org_b" }],
      })
    ).toEqual({ kind: "switch-organization", organizationId: "org_b" });
  });

  it("waits when the org matches but the filtered set lags a render", () => {
    expect(
      resolveProjectDeepLinkAction({
        ...base,
        allProjects: [{ _id: PROJECT_ID, organizationId: "org_a" }],
      })
    ).toEqual({ kind: "wait" });
  });

  it("reports not-found for an org-less project while an org filter is active", () => {
    // Waiting here would hang forever: an org-less project can never enter
    // the org-filtered set, so the param would never strip.
    expect(
      resolveProjectDeepLinkAction({
        ...base,
        allProjects: [{ _id: PROJECT_ID }],
      })
    ).toEqual({ kind: "not-found" });
  });

  it("waits for an org-less project when no org filter is active", () => {
    // Unfiltered set includes it next render; not-found would be premature.
    expect(
      resolveProjectDeepLinkAction({
        ...base,
        allProjects: [{ _id: PROJECT_ID }],
        activeOrganizationId: undefined,
      })
    ).toEqual({ kind: "wait" });
  });

  it("reports not-found for projects outside the user's membership", () => {
    expect(
      resolveProjectDeepLinkAction({
        ...base,
        allProjects: [{ _id: OTHER_ID, organizationId: "org_a" }],
      })
    ).toEqual({ kind: "not-found" });
  });
});

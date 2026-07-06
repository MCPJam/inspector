import { beforeEach, describe, expect, it } from "vitest";
import {
  capturePendingInviteOrgFromUrl,
  clearPendingInviteOrgMarker,
  readPendingInviteOrgMarker,
  writePendingInviteOrgMarker,
  writePendingInviteOrgMarkerForPath,
} from "../pending-invite-org";

describe("pending invite org", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("captures invite_org and strips it from the URL", () => {
    window.history.replaceState({}, "", "/?invite_org=org_123&x=1");

    expect(capturePendingInviteOrgFromUrl()).toMatchObject({
      organizationId: "org_123",
      returnPath: "/organizations/org_123",
      startedAt: expect.any(Number),
    });
    expect(readPendingInviteOrgMarker()).toMatchObject({
      organizationId: "org_123",
      returnPath: "/organizations/org_123",
      startedAt: expect.any(Number),
    });
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?x=1");
  });

  it("ignores unsafe org ids", () => {
    window.history.replaceState({}, "", "/?invite_org=../bad");

    expect(capturePendingInviteOrgFromUrl()).toBeNull();
    expect(readPendingInviteOrgMarker()).toBeNull();
  });

  it("round-trips stored invite markers", () => {
    writePendingInviteOrgMarker({
      organizationId: "org-abc_123",
      returnPath: "/organizations/org-abc_123",
      startedAt: 123,
    });

    expect(readPendingInviteOrgMarker()).toEqual({
      organizationId: "org-abc_123",
      returnPath: "/organizations/org-abc_123",
      startedAt: 123,
    });

    clearPendingInviteOrgMarker();
    expect(readPendingInviteOrgMarker()).toBeNull();
  });

  it("creates a marker from allowed organization paths", () => {
    expect(
      writePendingInviteOrgMarkerForPath("/organizations/org_123/billing")
    ).toMatchObject({
      organizationId: "org_123",
      returnPath: "/organizations/org_123/billing",
      startedAt: expect.any(Number),
    });
    expect(readPendingInviteOrgMarker()).toMatchObject({
      organizationId: "org_123",
      returnPath: "/organizations/org_123/billing",
      startedAt: expect.any(Number),
    });
  });

  it("rejects non-organization and nested paths", () => {
    expect(writePendingInviteOrgMarkerForPath("/servers")).toBeNull();
    expect(
      writePendingInviteOrgMarkerForPath("/organizations/org_123/admin")
    ).toBeNull();
    expect(
      writePendingInviteOrgMarkerForPath("/organizations/org_123/models/x")
    ).toBeNull();
    expect(readPendingInviteOrgMarker()).toBeNull();
  });

  it("rejects markers whose org and return path disagree", () => {
    writePendingInviteOrgMarker({
      organizationId: "org_a",
      returnPath: "/organizations/org_b",
      startedAt: 123,
    });

    expect(readPendingInviteOrgMarker()).toBeNull();
  });
});

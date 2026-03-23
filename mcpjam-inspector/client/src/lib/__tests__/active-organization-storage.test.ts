import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLegacyActiveOrganizationStorage,
  getActiveOrganizationStorageKey,
  readStoredActiveOrganizationId,
  writeStoredActiveOrganizationId,
} from "../active-organization-storage";

describe("active-organization-storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores organization selection per user", () => {
    writeStoredActiveOrganizationId("user-1", "org-1");
    writeStoredActiveOrganizationId("user-2", "org-2");

    expect(readStoredActiveOrganizationId("user-1")).toBe("org-1");
    expect(readStoredActiveOrganizationId("user-2")).toBe("org-2");
  });

  it("ignores the legacy global key", () => {
    localStorage.setItem("active-organization-id", "legacy-org");
    localStorage.setItem(getActiveOrganizationStorageKey("user-1"), "org-1");

    expect(readStoredActiveOrganizationId("user-1")).toBe("org-1");
    expect(readStoredActiveOrganizationId("user-2")).toBeUndefined();
  });

  it("clears the legacy global key", () => {
    localStorage.setItem("active-organization-id", "legacy-org");

    clearLegacyActiveOrganizationStorage();

    expect(localStorage.getItem("active-organization-id")).toBeNull();
  });
});

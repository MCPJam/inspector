import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLegacyActiveProjectStorage,
  getActiveProjectStorageKey,
  readStoredActiveProjectId,
  writeStoredActiveProjectId,
} from "../active-project-storage";

describe("active-project-storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores project selection per actor", () => {
    writeStoredActiveProjectId("user-1", "project-1");
    writeStoredActiveProjectId("guest-abc", "project-2");

    expect(readStoredActiveProjectId("user-1")).toBe("project-1");
    expect(readStoredActiveProjectId("guest-abc")).toBe("project-2");
  });

  it("returns null for an unknown actor", () => {
    writeStoredActiveProjectId("user-1", "project-1");
    expect(readStoredActiveProjectId("user-2")).toBeNull();
  });

  it("removes the entry when written with a null project id", () => {
    writeStoredActiveProjectId("user-1", "project-1");
    writeStoredActiveProjectId("user-1", null);
    expect(readStoredActiveProjectId("user-1")).toBeNull();
  });

  it("ignores the legacy global key", () => {
    localStorage.setItem("convex-active-project-id", "legacy-project");
    localStorage.setItem(getActiveProjectStorageKey("user-1"), "project-1");

    expect(readStoredActiveProjectId("user-1")).toBe("project-1");
    expect(readStoredActiveProjectId("user-2")).toBeNull();
  });

  it("clears the legacy global key", () => {
    localStorage.setItem("convex-active-project-id", "legacy-project");

    clearLegacyActiveProjectStorage();

    expect(localStorage.getItem("convex-active-project-id")).toBeNull();
  });

  it("does not read or write when actor key is null", () => {
    writeStoredActiveProjectId(null, "project-1");
    expect(readStoredActiveProjectId(null)).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});

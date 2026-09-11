import { describe, expect, it } from "vitest";

import type { InstallationRepo } from "@/hooks/useGithubChecksSettings";
import {
  findRepoByPickerValue,
  isSelectableGithubRepo,
  verifiedConnectArgs,
} from "@/lib/github-repo-picker";

const validRepo: InstallationRepo = {
  repositoryId: 123,
  installationRef: "binding_123",
  accountLogin: "acme",
  fullName: "acme/widgets",
};

describe("GitHub repository picker identity", () => {
  it("accepts a complete installation and repository identity", () => {
    expect(isSelectableGithubRepo(validRepo)).toBe(true);
    expect(findRepoByPickerValue([validRepo], "123")).toBe(validRepo);
    expect(
      verifiedConnectArgs(validRepo, {
        projectId: "project_123",
        suiteId: "suite_123",
        outagePolicy: "fail_closed",
      }),
    ).toMatchObject({
      installationRef: "binding_123",
      repositoryId: 123,
    });
  });

  it.each([
    { ...validRepo, installationRef: "" },
    { ...validRepo, installationRef: "   " },
    { ...validRepo, installationRef: undefined },
    { ...validRepo, repositoryId: 0 },
    { ...validRepo, repositoryId: Number.NaN },
  ])("rejects incomplete or invalid picker entries", (repo) => {
    const staleRepo = repo as InstallationRepo;
    expect(isSelectableGithubRepo(staleRepo)).toBe(false);
    expect(findRepoByPickerValue([staleRepo], String(repo.repositoryId))).toBe(
      undefined,
    );
    expect(() =>
      verifiedConnectArgs(staleRepo, {
        projectId: "project_123",
        suiteId: "suite_123",
        outagePolicy: "fail_open",
      }),
    ).toThrow("Connect a GitHub account");
  });
});

/**
 * The reviewer's credentials as project secrets named for the submission:
 * saved or not from the metadata list, written through the secrets API's
 * own actions with materialized delivery, shared with the project only when
 * an admin saves them.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSecretView } from "@/hooks/useProjectSecrets";
import {
  EMAIL_SECRET,
  PASSWORD_SECRET,
  SCOPE,
  secretRow,
} from "@/components/readiness/__tests__/reviewer-fixtures";
import {
  reviewerSecretNames,
  useReviewerCredentials,
} from "../use-reviewer-credentials";

const world = vi.hoisted(() => ({
  member: true as boolean | undefined,
  admin: true,
  roleLoading: false,
  rows: [] as ProjectSecretView[] | undefined,
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => world.member,
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectMembers: () => ({
    canManageMembers: world.admin,
    isLoading: world.roleLoading,
  }),
}));
vi.mock("@/hooks/useProjectSecrets", () => ({
  useProjectSecrets: () => world.rows,
  useCreateProjectSecret: () => world.create,
  useUpdateProjectSecret: () => world.update,
}));

const render = () => renderHook(() => useReviewerCredentials(SCOPE));

describe("reviewerSecretNames", () => {
  it("names both secrets for the submission, inside the reviewer prefix", () => {
    expect(reviewerSecretNames("sub_1")).toEqual({
      usernameSecretName: EMAIL_SECRET,
      passwordSecretName: PASSWORD_SECRET,
    });
    expect(reviewerSecretNames("k57bq3m0x8").passwordSecretName).toBe(
      "MCPJAM_REVIEWER_K57BQ3M0X8_PASSWORD",
    );
  });
});

describe("useReviewerCredentials", () => {
  beforeEach(() => {
    Object.assign(world, {
      member: true,
      admin: true,
      roleLoading: false,
      rows: [],
    });
    world.create.mockReset().mockResolvedValue({});
    world.update.mockReset().mockResolvedValue({});
  });

  it("is undecided while the secrets list loads", () => {
    world.rows = undefined;
    expect(render().result.current.saved).toBeUndefined();
  });

  it("is saved only when both secrets exist", () => {
    world.rows = [secretRow(PASSWORD_SECRET)];
    expect(render().result.current.saved).toBe(false);
    world.rows = [secretRow(EMAIL_SECRET), secretRow(PASSWORD_SECRET)];
    const { result } = render();
    expect(result.current.saved).toBe(true);
    expect(result.current.personal).toBe(false);
  });

  it("says personal when a saved secret is someone's own", () => {
    world.rows = [
      secretRow(EMAIL_SECRET, { sharing: "user", isOwner: true }),
      secretRow(PASSWORD_SECRET, { sharing: "user", isOwner: true }),
    ];
    expect(render().result.current.personal).toBe(true);
  });

  it("creates both as project secrets for an admin, with materialized delivery", async () => {
    const { result } = render();
    await act(() => result.current.save("review@example.com", "sample-pass-1"));
    expect(world.create.mock.calls).toEqual([
      [
        {
          projectId: "proj_1",
          name: EMAIL_SECRET,
          value: "review@example.com",
          delivery: "materialized",
          sharing: "project",
          description:
            "Directory reviewer email, saved from the Readiness page",
        },
      ],
      [
        {
          projectId: "proj_1",
          name: PASSWORD_SECRET,
          value: "sample-pass-1",
          delivery: "materialized",
          sharing: "project",
          description:
            "Directory reviewer password, saved from the Readiness page",
        },
      ],
    ]);
    expect(world.update).not.toHaveBeenCalled();
  });

  it("creates personal ones for anyone else, and says so before saving", async () => {
    world.admin = false;
    const { result } = render();
    expect(result.current.personal).toBe(true);
    await act(() => result.current.save("review@example.com", "sample-pass-1"));
    expect(world.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: PASSWORD_SECRET, sharing: "user" }),
    );
  });

  it("rotates a secret that exists, keeping its sharing, and creates the other", async () => {
    world.rows = [secretRow(PASSWORD_SECRET, { delivery: "brokered" })];
    const { result } = render();
    await act(() => result.current.save("review@example.com", "sample-pass-2"));
    expect(world.update).toHaveBeenCalledWith({
      projectId: "proj_1",
      secretId: `secret_${PASSWORD_SECRET}`,
      value: "sample-pass-2",
      delivery: "materialized",
    });
    expect(world.create).toHaveBeenCalledTimes(1);
    expect(world.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: EMAIL_SECRET }),
    );
  });

  it("lets a member save once the role is known, and never a guest", () => {
    world.roleLoading = true;
    expect(render().result.current.canSave).toBe(false);
    world.roleLoading = false;
    expect(render().result.current.canSave).toBe(true);

    world.member = false;
    world.rows = undefined;
    const { result } = render();
    expect(result.current.canSave).toBe(false);
    expect(result.current.saved).toBe(false);
  });
});

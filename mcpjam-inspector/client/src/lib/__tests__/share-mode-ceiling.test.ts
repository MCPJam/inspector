import { describe, expect, it } from "vitest";
import {
  applyShareCeilingToOptions,
  clampShareMode,
  isShareModeAboveCeiling,
  orgShareLimitReason,
  SHARE_MODE_RANK,
} from "../share-mode-ceiling";
import type { ShareAccessOption } from "@/components/sharing/share-types";

const PRESETS: readonly ShareAccessOption[] = [
  { value: "project_members", label: "Project members", description: "" },
  { value: "invited_only", label: "Invited users only", description: "" },
  { value: "anyone_with_link", label: "Anyone with the link", description: "" },
];

describe("share-mode-ceiling", () => {
  it("ranks modes from project members to anyone with the link", () => {
    expect(SHARE_MODE_RANK.project_members).toBe(0);
    expect(SHARE_MODE_RANK.invited_only).toBe(1);
    expect(SHARE_MODE_RANK.anyone_with_link).toBe(2);
  });

  it("treats an undefined ceiling as no limit", () => {
    expect(clampShareMode("anyone_with_link")).toBe("anyone_with_link");
    expect(isShareModeAboveCeiling("anyone_with_link")).toBe(false);
    expect(
      applyShareCeilingToOptions(PRESETS).every((option) => !option.disabled),
    ).toBe(true);
  });

  it("clamps a mode down to the ceiling", () => {
    expect(clampShareMode("anyone_with_link", "invited_only")).toBe(
      "invited_only",
    );
    expect(clampShareMode("invited_only", "anyone_with_link")).toBe(
      "invited_only",
    );
  });

  it("disables over-ceiling presets with the org-limit copy", () => {
    const options = applyShareCeilingToOptions(PRESETS, "invited_only");
    expect(options.find((o) => o.value === "project_members")?.disabled).toBe(
      undefined,
    );
    expect(options.find((o) => o.value === "invited_only")?.disabled).toBe(
      undefined,
    );
    const link = options.find((o) => o.value === "anyone_with_link");
    expect(link?.disabled).toBe(true);
    expect(link?.disabledReason).toBe(
      orgShareLimitReason("invited_only"),
    );
    expect(link?.disabledReason).toBe(
      "Your organization limits sharing to invited users only.",
    );
  });
});

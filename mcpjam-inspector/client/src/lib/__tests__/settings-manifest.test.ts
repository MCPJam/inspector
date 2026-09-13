import { describe, expect, it } from "vitest";
import {
  resolveSettingsDestination,
  searchSettings,
  settingsPath,
  settingsBackTarget,
} from "../settings-manifest";

const context = {
  organizationId: "org-a",
  projectId: "projectaaaaaaaaa",
  authenticated: true,
  remoteProject: true,
};
describe("settings destinations", () => {
  it("makes Support a searchable Settings destination", () => {
    expect(resolveSettingsDestination("/settings/support")?.id).toBe("personal-support");
    expect(settingsPath("personal-support", context)).toBe("/settings/support");
    expect(searchSettings("help", context)[0].destination.id).toBe("personal-support");
  });
  it("opens Profile by default and keeps Appearance separately reachable", () => {
    expect(resolveSettingsDestination("/settings")?.id).toBe(
      "personal-profile",
    );
    expect(resolveSettingsDestination("/profile")?.id).toBe("personal-profile");
    expect(settingsPath("personal-profile", context)).toBe("/settings");
    expect(settingsPath("personal-appearance", context)).toBe(
      "/settings/appearance",
    );
  });
  it("consolidates organization members and sharing into one destination", () => {
    expect(resolveSettingsDestination("/organizations/org-a/sharing")?.id).toBe(
      "org-members",
    );
    expect(
      resolveSettingsDestination("/organizations/org-a/members")?.label,
    ).toBe("Members & sharing");
    expect(settingsPath("org-members", context)).toBe(
      "/organizations/org-a/members",
    );
    expect(searchSettings("sharing policy", context)[0].destination.id).toBe(
      "org-members",
    );
  });
  it("separates plans and organization key inventory from personal keys and billing", () => {
    expect(settingsPath("org-plans", context)).toBe(
      "/organizations/org-a/plans",
    );
    expect(settingsPath("org-api-keys", context)).toBe(
      "/organizations/org-a/api-keys",
    );
    expect(
      resolveSettingsDestination("/organizations/org-a/api-keys")?.id,
    ).toBe("org-api-keys");
    expect(resolveSettingsDestination("/settings/api-keys")?.id).toBe(
      "personal-api-keys",
    );
  });
  it("keeps existing URLs and resolves service details to Integrations", () => {
    expect(settingsPath("org-byok", context)).toBe(
      "/organizations/org-a/models",
    );
    expect(resolveSettingsDestination("/organizations/org-a/budget")?.id).toBe(
      "org-billing",
    );
    expect(resolveSettingsDestination("/organizations/org-a/slack")?.id).toBe(
      "org-integrations",
    );
    expect(
      resolveSettingsDestination("/settings/integrations/github/callback")?.id,
    ).toBe("org-integrations");
    expect(
      resolveSettingsDestination("/p/projectaaaaaaaaa/project-settings/secrets")
        ?.id,
    ).toBe("project-secrets");
    expect(resolveSettingsDestination("/settings/about")?.id).toBe(
      "personal-about",
    );
    expect(resolveSettingsDestination("/servers")).toBeUndefined();
  });
  it("searches static aliases and preserves unrelated query parameters", () => {
    expect(searchSettings("models", context)[0].destination.id).toBe(
      "org-byok",
    );
    const result = searchSettings("spend limit", context)[0];
    expect(result.target).toBe("spend-budget");
    expect(
      settingsPath(
        result.destination.id,
        context,
        "?checkout=ok&tab=activity",
        result.target,
      ),
    ).toBe(
      "/organizations/org-a/billing?checkout=ok&tab=activity&setting=spend-budget",
    );
    expect(searchSettings("invite", context)[0].destination.id).toBe(
      "org-members",
    );
    expect(searchSettings("no matching setting", context)).toEqual([]);
  });
  it("does not expose remote project or organization controls without context", () => {
    const results = searchSettings("", {
      authenticated: false,
      remoteProject: false,
    });
    expect(
      results.every((r) => ["Personal", "App"].includes(r.destination.group)),
    ).toBe(true);
    expect(
      searchSettings("secrets", { ...context, remoteProject: false }),
    ).toEqual([]);
  });
  it("searches integration controls only when their existing availability allows them", () => {
    expect(searchSettings("Slack", context)[0].target).toBe("slack");
    expect(searchSettings("GitHub", context)).toEqual([]);
    expect(searchSettings("Discord", context).some((result) => result.target === "discord")).toBe(false);
    expect(searchSettings("OTLP", context)).toEqual([]);
    expect(
      searchSettings("spend limit", { ...context, personalOrganization: true }),
    ).toEqual([]);
    expect(
      searchSettings("GitHub", { ...context, features: { github: true } })[0]
        .target,
    ).toBe("github");
    expect(
      searchSettings("OTLP", {
        ...context,
        features: { observability: true },
      })[0].target,
    ).toBe("observability");
  });
  it("returns to the recorded context, falling back after a context switch", () => {
    const previous = {
      path: "/p/projectaaaaaaaaa/sessions?session=123",
      organizationId: "org-a",
      projectId: "projectaaaaaaaaa",
    };
    expect(
      settingsBackTarget(previous, context, "/p/projectaaaaaaaaa/home"),
    ).toBe(previous.path);
    expect(
      settingsBackTarget(
        previous,
        { ...context, organizationId: "org-b" },
        "/p/projectbbbbbbbbb/home",
      ),
    ).toBe("/p/projectbbbbbbbbb/home");
  });
});

import { describe, expect, it } from "vitest";
import {
  getInvalidOrganizationRouteNavigationTarget,
  getWorkspaceSwitchNavigationTarget,
  getNormalizedHashParts,
  resolveHostedNavigation,
} from "../hosted-navigation";

describe("hosted-navigation", () => {
  it("normalizes hash aliases and strips hash prefix", () => {
    expect(getNormalizedHashParts("#registry")).toEqual(["servers"]);
    expect(getNormalizedHashParts("#/chat")).toEqual(["chat-v2"]);
    expect(getNormalizedHashParts("prompts")).toEqual(["prompts"]);
  });

  it("marks blocked tabs in hosted mode", () => {
    const resolved = resolveHostedNavigation("#skills", true);
    expect(resolved.normalizedTab).toBe("skills");
    expect(resolved.isBlocked).toBe(true);
  });

  it("allows blocked-hosted tabs in local mode", () => {
    const resolved = resolveHostedNavigation("#skills", false);
    expect(resolved.isBlocked).toBe(false);
  });

  it("extracts organization route params and chat-v2 flags", () => {
    const orgResolved = resolveHostedNavigation("#organizations/org_123", true);
    expect(orgResolved.organizationId).toBe("org_123");
    expect(orgResolved.organizationSection).toBe("overview");
    expect(orgResolved.shouldSelectAllServers).toBe(false);
    expect(orgResolved.shouldClearChatMessages).toBe(true);

    const chatResolved = resolveHostedNavigation("#chat-v2", true);
    expect(chatResolved.organizationId).toBeUndefined();
    expect(chatResolved.shouldSelectAllServers).toBe(true);
    expect(chatResolved.shouldClearChatMessages).toBe(false);
  });

  it("returns canonical section for hash synchronization", () => {
    const resolved = resolveHostedNavigation("#/registry", true);
    expect(resolved.rawSection).toBe("registry");
    expect(resolved.normalizedSection).toBe("servers");
  });

  it("normalizes organization billing subroutes", () => {
    const billingResolved = resolveHostedNavigation(
      "#organizations/org_123/billing",
      true,
    );
    expect(billingResolved.organizationId).toBe("org_123");
    expect(billingResolved.organizationSection).toBe("billing");
    expect(billingResolved.normalizedSection).toBe(
      "organizations/org_123/billing",
    );

    const unknownResolved = resolveHostedNavigation(
      "#organizations/org_123/unknown",
      true,
    );
    expect(unknownResolved.organizationId).toBe("org_123");
    expect(unknownResolved.organizationSection).toBe("overview");
    expect(unknownResolved.normalizedSection).toBe("organizations/org_123");
  });

  it("allows ci-evals in hosted mode", () => {
    const resolved = resolveHostedNavigation("#ci-evals", true);
    expect(resolved.normalizedTab).toBe("ci-evals");
    expect(resolved.isBlocked).toBe(false);
  });

  it("treats sandboxes as a normal hosted app tab", () => {
    const resolved = resolveHostedNavigation("#sandboxes", true);
    expect(resolved.normalizedTab).toBe("sandboxes");
    expect(resolved.isBlocked).toBe(false);
    expect(resolved.shouldSelectAllServers).toBe(false);
    expect(resolved.shouldClearChatMessages).toBe(true);
  });

  it("exits stale organization routes when switching to a workspace in another org", () => {
    expect(
      getWorkspaceSwitchNavigationTarget({
        activeTab: "organizations",
        activeOrganizationId: "org-a",
        nextWorkspaceOrganizationId: "org-b",
      }),
    ).toBe("servers");
    expect(
      getWorkspaceSwitchNavigationTarget({
        activeTab: "organizations",
        activeOrganizationId: "org-a",
        nextWorkspaceOrganizationId: undefined,
      }),
    ).toBe("servers");
  });

  it("keeps the organization route when switching within the same org", () => {
    expect(
      getWorkspaceSwitchNavigationTarget({
        activeTab: "organizations",
        activeOrganizationId: "org-a",
        nextWorkspaceOrganizationId: "org-a",
      }),
    ).toBeNull();
    expect(
      getWorkspaceSwitchNavigationTarget({
        activeTab: "servers",
        activeOrganizationId: "org-a",
        nextWorkspaceOrganizationId: "org-b",
      }),
    ).toBeNull();
  });

  it("redirects invalid organization routes once organizations finish loading", () => {
    expect(
      getInvalidOrganizationRouteNavigationTarget({
        routeTab: "organizations",
        routeOrganizationId: "org-a",
        isLoadingOrganizations: false,
        hasRouteOrganization: false,
      }),
    ).toBe("servers");
    expect(
      getInvalidOrganizationRouteNavigationTarget({
        routeTab: "organizations",
        routeOrganizationId: undefined,
        isLoadingOrganizations: false,
        hasRouteOrganization: false,
      }),
    ).toBe("servers");
  });

  it("keeps valid organization routes and waits for loading state", () => {
    expect(
      getInvalidOrganizationRouteNavigationTarget({
        routeTab: "organizations",
        routeOrganizationId: "org-a",
        isLoadingOrganizations: false,
        hasRouteOrganization: true,
      }),
    ).toBeNull();
    expect(
      getInvalidOrganizationRouteNavigationTarget({
        routeTab: "organizations",
        routeOrganizationId: "org-a",
        isLoadingOrganizations: true,
        hasRouteOrganization: false,
      }),
    ).toBeNull();
    expect(
      getInvalidOrganizationRouteNavigationTarget({
        routeTab: "servers",
        routeOrganizationId: undefined,
        isLoadingOrganizations: false,
        hasRouteOrganization: false,
      }),
    ).toBeNull();
  });
});

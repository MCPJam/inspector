import { beforeEach, describe, expect, it, vi } from "vitest";

const initiateOAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  OAUTH_PENDING_STORAGE_KEY: "mcp-oauth-pending",
  initiateOAuth,
}));
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  captureCurrentReturnPath: () => "/p/abcdefghijklmnop/servers",
}));

import { readHostedOAuthPendingMarker } from "@/lib/hosted-oauth-callback";
import {
  pluginSignInFlowName,
  startPluginServerSignIn,
  type PluginServerSignInTarget,
} from "../plugin-sign-in";

const target: PluginServerSignInTarget = {
  pluginId: "plg_mail",
  pluginVersionId: "ver_mail",
  componentKey: "inbox",
  serverId: "srv_mail",
  serverName: "mail",
  serverUrl: "https://mail.example.com/mcp",
  scopes: ["mail.read"],
  registrationMode: "dcr",
};

const start = () =>
  startPluginServerSignIn({
    target,
    projectId: "ws_1",
    organizationId: "org_1",
    initiatingUserId: "user_1",
  });

describe("startPluginServerSignIn", () => {
  beforeEach(() => {
    localStorage.clear();
    initiateOAuth.mockReset();
  });

  it("pins the project, page, plugin version and component, then starts the hosted flow", async () => {
    initiateOAuth.mockImplementation(async () => {
      // Read while the flow runs: the callback finds the marker this way.
      expect(readHostedOAuthPendingMarker()).toMatchObject({
        surface: "project",
        initiatingUserId: "user_1",
        organizationId: "org_1",
        projectId: "ws_1",
        serverId: "srv_mail",
        serverName: "mail (plugin)",
        serverUrl: "https://mail.example.com/mcp",
        accessScope: "project_member",
        returnPath: "/p/abcdefghijklmnop/servers",
        pluginSignIn: { pluginVersionId: "ver_mail", componentKey: "inbox" },
      });
      return { success: true };
    });

    await expect(start()).resolves.toEqual({ success: true });

    expect(initiateOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "hosted-connect",
        serverName: "mail (plugin)",
        serverUrl: "https://mail.example.com/mcp",
        scopes: ["mail.read"],
        registrationMode: "dcr",
      }),
    );
    expect(localStorage.getItem("mcp-oauth-return-hash")).toBe(
      "/p/abcdefghijklmnop/servers",
    );
  });

  it("leaves nothing for a later callback when the flow cannot start", async () => {
    initiateOAuth.mockResolvedValue({ success: false, error: "No metadata" });
    localStorage.setItem("mcp-oauth-pending", "mail (plugin)");

    await expect(start()).resolves.toEqual({
      success: false,
      error: "No metadata",
    });

    expect(readHostedOAuthPendingMarker()).toBeNull();
    expect(localStorage.getItem("mcp-oauth-pending")).toBeNull();
    expect(localStorage.getItem("mcp-oauth-return-hash")).toBeNull();
  });

  it("keeps the flow's browser state apart from a project server of the same name", () => {
    expect(pluginSignInFlowName("mail")).not.toBe("mail");
  });
});

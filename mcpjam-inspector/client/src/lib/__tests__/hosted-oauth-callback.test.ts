import { beforeEach, describe, expect, it } from "vitest";
import {
  HOSTED_OAUTH_PENDING_STORAGE_KEY,
  onlyStoresCredential,
  readHostedOAuthPendingMarker,
  resolveHostedOAuthReturnPath,
  writeHostedOAuthPendingMarker,
} from "../hosted-oauth-callback";

describe("hosted OAuth return paths", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("preserves scenario slug return paths", () => {
    writeHostedOAuthPendingMarker({
      surface: "scenario",
      serverName: "Asana",
      serverUrl: "https://example.com/mcp",
      returnPath: "/asana",
    });

    expect(readHostedOAuthPendingMarker()?.returnPath).toBe("/asana");
    expect(
      resolveHostedOAuthReturnPath({
        surface: "scenario",
        returnPath: "/asana",
      }),
    ).toBe("/asana");
  });

  it("preserves inline-surface toast suppression across a redirect", () => {
    writeHostedOAuthPendingMarker({
      surface: "project",
      serverName: "Asana",
      serverUrl: "https://example.com/mcp",
      returnPath: "/home",
      suppressErrorToast: true,
      suppressSuccessToast: true,
    });

    expect(readHostedOAuthPendingMarker()).toEqual(
      expect.objectContaining({
        suppressErrorToast: true,
        suppressSuccessToast: true,
      }),
    );
  });

  it("accepts legacy scenario hash return targets", () => {
    expect(
      resolveHostedOAuthReturnPath({
        surface: "scenario",
        returnPath: "#asana",
      }),
    ).toBe("/asana");
  });

  it("keeps project return targets on known app routes", () => {
    expect(
      resolveHostedOAuthReturnPath({
        surface: "project",
        returnPath: "#/evals",
      }),
    ).toBe("/evals");
    expect(
      resolveHostedOAuthReturnPath({
        surface: "project",
        returnPath: "/not-an-app-route",
      }),
    ).toBe("/servers");
  });

  it("reads in-flight pending markers that still use the old returnHash field", () => {
    localStorage.setItem(
      "mcp-hosted-oauth-pending",
      JSON.stringify({
        surface: "project",
        serverName: "Asana",
        serverUrl: "https://example.com/mcp",
        returnHash: "#/evals",
        startedAt: Date.now(),
      }),
    );

    expect(readHostedOAuthPendingMarker()?.returnPath).toBe("/evals");
  });
});

describe("a plugin server's sign-in marker", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const marker = {
    surface: "project" as const,
    projectId: "ws_1",
    serverId: "srv_mail",
    serverName: "mail (plugin)",
    serverUrl: "https://mail.example.com/mcp",
    returnPath: "/servers",
  };

  it("survives the redirect and makes the callback store a credential only", () => {
    writeHostedOAuthPendingMarker({
      ...marker,
      pluginSignIn: { pluginVersionId: "ver_mail", componentKey: "inbox" },
    });
    const read = readHostedOAuthPendingMarker();
    expect(read?.pluginSignIn).toEqual({
      pluginVersionId: "ver_mail",
      componentKey: "inbox",
    });
    expect(onlyStoresCredential(read)).toBe(true);
  });

  it("drops a malformed binding, leaving an ordinary project callback", () => {
    localStorage.setItem(
      HOSTED_OAUTH_PENDING_STORAGE_KEY,
      JSON.stringify({
        ...marker,
        pluginSignIn: { pluginVersionId: "ver_mail" },
        startedAt: Date.now(),
      }),
    );
    const read = readHostedOAuthPendingMarker();
    expect(read?.serverId).toBe("srv_mail");
    expect(read?.pluginSignIn).toBeUndefined();
    expect(onlyStoresCredential(read)).toBe(false);
  });

  it("treats a connection change as credential-only too, and nothing else", () => {
    expect(onlyStoresCredential({ ...marker, startedAt: 1 })).toBe(false);
    expect(
      onlyStoresCredential({
        ...marker,
        startedAt: 1,
        connectionIntent: { kind: "add" },
      }),
    ).toBe(true);
    expect(onlyStoresCredential(null)).toBe(false);
  });
});

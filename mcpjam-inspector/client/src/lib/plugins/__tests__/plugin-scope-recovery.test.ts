import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ initiateOAuth: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/oauth/mcp-oauth", () => ({
  OAUTH_PENDING_STORAGE_KEY: "mcp-oauth-pending",
  initiateOAuth: mocks.initiateOAuth,
  clearOAuthData: vi.fn(),
  hasOAuthConfig: vi.fn(),
  readStoredOAuthConfig: () => ({}),
  resolveStoredIssuer: () => "https://auth.mail.example",
}));
vi.mock("@/lib/toast", () => ({ toast: { info: mocks.toast } }));

import { unavailableServersForNotice } from "../hidden-environment";
import {
  registerPluginNoticeSignIn,
  resetShownPluginNotices,
  showPluginNotice,
} from "../plugin-notice-display";
import {
  startPluginServerSignIn,
  type PluginServerSignInRequest,
  type PluginServerSignInTarget,
} from "../plugin-sign-in";
import { readHostedOAuthPendingMarker } from "@/lib/hosted-oauth-callback";
import { persistRequestedScopes } from "@/lib/oauth/requested-scopes";
import type { ActivePluginRow } from "../active-plugins-types";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

const target: PluginServerSignInTarget = {
  pluginId: "plg_mail",
  pluginVersionId: "ver_mail",
  componentKey: "inbox",
  serverId: "srv_mail",
  serverName: "mail",
  serverUrl: "https://mail.example/mcp",
  scopes: ["mail.read"],
  registrationMode: "dcr",
};
const plugins: ActivePluginRow[] = [
  {
    pluginId: target.pluginId,
    pluginVersionId: target.pluginVersionId,
    name: "mail",
    displayName: "Mail",
    status: "active",
    servers: [
      {
        serverId: target.serverId,
        name: "mail",
        componentKey: target.componentKey,
        placement: "remote",
      },
    ],
    skills: [],
  },
];
const scopeChallenge = {
  requiredScope: "mail.write",
  resourceMetadataUrl: "https://metadata.mail.example/resource",
};
const start = (request: PluginServerSignInRequest) =>
  startPluginServerSignIn({
    target,
    scopeChallenge: request.scopeChallenge,
    projectId: "ws_1",
    organizationId: "org_1",
    initiatingUserId: "user_1",
    returnPath: "/p/abcdefghijklmnop/playground",
  });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  resetShownPluginNotices();
  mocks.initiateOAuth.mockResolvedValue({ success: true });
});

describe("plugin scope recovery", () => {
  it("carries a server-bound notice through Sign in to a widened credential-only OAuth flow", async () => {
    persistRequestedScopes("mail (plugin)", "https://auth.mail.example", [
      "mail.archive",
    ]);
    const notices = unavailableServersForNotice(plugins, [
      { serverId: "srv_mail", reason: "needs_auth", scopeChallenge },
    ]);
    let pending: ReturnType<typeof start> | undefined;
    const unregister = registerPluginNoticeSignIn((binding) => {
      pending = start(binding);
    });
    try {
      showPluginNotice("chat", { kind: "skipped", plugins: notices });
      const action = mocks.toast.mock.calls[0][1].action;
      expect(action.label).toBe("Sign in");
      action.onClick();
      await pending;
    } finally {
      unregister();
    }
    expect(mocks.initiateOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: "step-up",
        scopes: ["mail.read", "mail.archive", "mail.write"],
        resourceMetadataUrl: scopeChallenge.resourceMetadataUrl,
      }),
    );
    expect(readHostedOAuthPendingMarker()).toMatchObject({
      projectId: "ws_1",
      serverId: "srv_mail",
      returnPath: "/p/abcdefghijklmnop/playground",
      pluginSignIn: { pluginVersionId: "ver_mail", componentKey: "inbox" },
    });
    expect(JSON.stringify(useTrafficLogStore.getState())).not.toContain(
      scopeChallenge.resourceMetadataUrl,
    );
    expect(
      unavailableServersForNotice(plugins, [
        { serverId: "some_other_server", reason: "needs_auth", scopeChallenge },
      ]),
    ).toEqual([]);
  });

  it("bounds repeated challenges across the redirect without dropping stored scopes", async () => {
    const request = {
      pluginVersionId: "ver_mail",
      componentKey: "inbox",
      scopeChallenge,
    };
    expect(await start(request)).toEqual({ success: true });
    expect((await start(request)).success).toBe(false);
    expect(mocks.initiateOAuth).toHaveBeenCalledTimes(1);
  });

  it.each(["/relative", "http://metadata.mail.example/resource", "not a URL"])(
    "ignores the invalid metadata override %s",
    async (resourceMetadataUrl) => {
      await start({
        pluginVersionId: "ver_mail",
        componentKey: "inbox",
        scopeChallenge: { requiredScope: "mail.write", resourceMetadataUrl },
      });
      expect(mocks.initiateOAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          scopes: ["mail.read", "mail.write"],
          resourceMetadataUrl: undefined,
        }),
      );
    },
  );

  it("keeps a metadata-only challenge's existing scopes", async () => {
    await start({
      pluginVersionId: "ver_mail",
      componentKey: "inbox",
      scopeChallenge: {
        resourceMetadataUrl: scopeChallenge.resourceMetadataUrl,
      },
    });
    expect(mocks.initiateOAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["mail.read"],
        resourceMetadataUrl: scopeChallenge.resourceMetadataUrl,
      }),
    );
  });

  it("shows a fresh action when the same server challenges different permissions", () => {
    const notices = (requiredScope: string) =>
      unavailableServersForNotice(plugins, [
        {
          serverId: "srv_mail",
          reason: "needs_auth",
          scopeChallenge: { requiredScope },
        },
      ]);
    expect(
      showPluginNotice("chat", {
        kind: "skipped",
        plugins: notices("mail.write"),
      }),
    ).toBe(true);
    expect(
      showPluginNotice("chat", {
        kind: "skipped",
        plugins: notices("mail.send"),
      }),
    ).toBe(true);
    expect(
      showPluginNotice("chat", {
        kind: "skipped",
        plugins: notices("mail.send"),
      }),
    ).toBe(false);
  });
});

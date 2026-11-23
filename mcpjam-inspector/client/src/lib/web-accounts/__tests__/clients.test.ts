import { describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import { WEB_CLIENTS_FLAG } from "@/hooks/useWebClientsEnabled";
import { WEB_CLIENTS_FEATURE_FLAG } from "@/shared/web-clients";
import { CLIENT_FEATURE_FLAG_KEYS } from "@/shared/client-feature-flags";
import { createWebAccountView } from "@/test/factories";
import { webAccountsApi, type WebAccount } from "../api";
import {
  newWebAccountLabel,
  runAccountOf,
  webAccountAsConnection,
  webAccountName,
  webAccountReconnectPath,
  webClientSite,
  pickableHosts,
  webClientVendorOfHost,
} from "../clients";

const account = (over: Partial<WebAccount> = {}): WebAccount =>
  createWebAccountView({ webAccountId: "wa-1", isDefault: false, ...over });

describe("web accounts helpers", () => {
  it("reads the client flag by the shared contract's key", () => {
    expect(WEB_CLIENTS_FLAG).toBe(WEB_CLIENTS_FEATURE_FLAG);
    expect(CLIENT_FEATURE_FLAG_KEYS).toContain(WEB_CLIENTS_FEATURE_FLAG);
  });

  it("knows a web client by its runtime, from a list row or a config", () => {
    expect(webClientVendorOfHost({ runtime: "claude-web" })).toBe("claude");
    expect(webClientVendorOfHost({ harness: "chatgpt-web" })).toBe("chatgpt");
    expect(webClientVendorOfHost({ runtime: "claude-code" })).toBeUndefined();
    expect(webClientVendorOfHost({ runtime: null })).toBeUndefined();
    expect(webClientVendorOfHost({})).toBeUndefined();
  });

  it("leaves web clients out of every picker while the flag is off", () => {
    const hosts = [
      { hostId: "web", runtime: "chatgpt-web" },
      { hostId: "code", runtime: "claude-code" },
      { hostId: "plain" },
    ];
    expect(pickableHosts(hosts, false).map((h) => h.hostId)).toEqual([
      "code",
      "plain",
    ]);
    expect(pickableHosts(hosts, true).map((h) => h.hostId)).toEqual([
      "web",
      "code",
      "plain",
    ]);
  });

  it("keeps a web client already picked, in place, while the flag is off", () => {
    const hosts = [
      { hostId: "code", runtime: "claude-code" },
      { hostId: "web", runtime: "chatgpt-web" },
      { hostId: "web-2", runtime: "claude-web" },
    ];
    expect(
      pickableHosts(hosts, false, ["web", null]).map((h) => h.hostId),
    ).toEqual(["code", "web"]);
  });

  it("names each vendor's site", () => {
    expect(webClientSite("claude")).toBe("claude.ai");
    expect(webClientSite("chatgpt")).toBe("chatgpt.com");
  });

  it("shows a web account in the shared account list", () => {
    expect(
      webAccountAsConnection(
        account({ status: "needs_sign_in", isDefault: true, label: "QA" }),
      ),
    ).toEqual({
      connectionId: "wa-1",
      label: "QA",
      isDefault: true,
      needsReauth: true,
      profile: { id: "wa-1", email: "qa@example.com", name: undefined },
    });
    expect(
      webAccountAsConnection(account({ accountEmail: undefined })).profile,
    ).toBeUndefined();
    expect(
      webAccountName(account({ accountEmail: undefined, label: "QA" })),
    ).toBe("QA");
  });

  it("names a new account so it doesn't collide with the client's others", () => {
    expect(newWebAccountLabel("claude", [])).toBe("Claude web account");
    expect(
      newWebAccountLabel("chatgpt", [
        account({ label: "ChatGPT web account" }),
        account({ label: "chatgpt web account 2" }),
      ]),
    ).toBe("ChatGPT web account 3");
  });

  it("links to the reconnect page the way the backend's email does", () => {
    expect(webAccountReconnectPath("wa 1", "project-1", "req-1")).toBe(
      "/web-accounts/wa%201/reconnect?request=req-1&project=project-1",
    );
    expect(webAccountReconnectPath("wa-1", "project-1")).toBe(
      "/web-accounts/wa-1/reconnect?project=project-1",
    );
  });

  it("calls the backend's web client modules", () => {
    expect(getFunctionName(webAccountsApi.list)).toBe(
      "webClients:listWebAccounts",
    );
    expect(getFunctionName(webAccountsApi.setAllowLocalRuns)).toBe(
      "webClients:setWebAccountAllowLocalRuns",
    );
    expect(getFunctionName(webAccountsApi.setDefault)).toBe(
      "webClients:setDefaultWebAccount",
    );
    expect(getFunctionName(webAccountsApi.mySuiteChoices)).toBe(
      "webClientSuites:getMySuiteWebAccountChoices",
    );
    expect(getFunctionName(webAccountsApi.setSuiteSelection)).toBe(
      "webClientSuites:setSuiteWebAccountSelection",
    );
    expect(getFunctionName(webAccountsApi.create)).toBe(
      "webClients:createWebAccount",
    );
    expect(getFunctionName(webAccountsApi.reconnectRequests)).toBe(
      "webClientReconnect:listWebReconnectRequests",
    );
  });

  it("runs on the default account, else the first", () => {
    const first = account({ webAccountId: "a" });
    const fallback = account({ webAccountId: "b", isDefault: true });
    expect(runAccountOf([first, fallback])).toBe(fallback);
    expect(runAccountOf([first])).toBe(first);
    expect(runAccountOf([])).toBeUndefined();
  });
});

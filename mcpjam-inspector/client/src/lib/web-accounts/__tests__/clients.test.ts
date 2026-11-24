import { describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import { WEB_CLIENTS_FLAG } from "@/hooks/useWebClientsEnabled";
import { WEB_CLIENTS_FEATURE_FLAG } from "@/shared/web-clients";
import { CLIENT_FEATURE_FLAG_KEYS } from "@/shared/client-feature-flags";
import { createWebAccountView } from "@/test/factories";
import { webAccountsApi, type WebAccount } from "../api";
import {
  webAccountAsConnection,
  webAccountName,
  webClientSite,
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
  });
});

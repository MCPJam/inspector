import { describe, expect, it } from "vitest";
import { createMemorySendJournal } from "../../../../utils/harness/real-ui/drive-turn.js";
import { createFixtureWebPageModule } from "../../../../utils/harness/real-ui/fixture-web.js";
import { RealUiError } from "../../../../utils/harness/real-ui/page-module.js";
import type { WebClientEnvironment } from "../../web-client-environment.js";
import { accountBrowserOver } from "../account-browser.js";

/** An environment whose browser can't open: the account has no saved sign-in. */
function environmentOpening(error: Error): WebClientEnvironment {
  return {
    publicBaseUrl: "https://inspector.example.test",
    journal: createMemorySendJournal(),
    pageModule: createFixtureWebPageModule("https://claude.ai"),
    resolveAccount: async () => ({ webAccountId: "account-a" }),
    ensureConnector: async () => ({ connectorId: "connector-1" }),
    openBrowser: async () => {
      throw error;
    },
  };
}

describe("accountBrowserOver", () => {
  it("reads an account whose browser opens signed out as not signed in", async () => {
    const signedOut = new RealUiError({
      kind: "needs_sign_in",
      reason: "signed_out",
      step: "sign_in_check",
      message: "Sign in to Claude again.",
    });
    const browser = accountBrowserOver(environmentOpening(signedOut), {
      webAccountId: "account-a",
      vendor: "claude",
    });

    await expect(browser.verifyAccount()).resolves.toBeUndefined();
  });

  it("lets any other failure to open the browser through", async () => {
    const browser = accountBrowserOver(
      environmentOpening(new Error("The browser daemon is down.")),
      { webAccountId: "account-a", vendor: "claude" },
    );

    await expect(browser.verifyAccount()).rejects.toThrow(
      "The browser daemon is down.",
    );
  });
});

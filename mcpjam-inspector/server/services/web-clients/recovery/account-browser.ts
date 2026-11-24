/**
 * The account's browser as recovery uses it: opened through the run's
 * environment on first use, read for who is signed in by the vendor's own
 * page module, and closed by whoever asked for it. The browser a person signs
 * in with is the environment's to give; the hosted one plugs in there.
 */
import {
  WEB_CLIENT_SITES,
  type WebClientVendor,
} from "../../../../shared/web-clients.js";
import { chatgptWebPageModule } from "../../../utils/harness/real-ui/chatgpt-web.js";
import { claudeWebPageModule } from "../../../utils/harness/real-ui/claude-web.js";
import {
  RealUiError,
  type RealUiPageModule,
} from "../../../utils/harness/real-ui/page-module.js";
import type { WebClientEnvironment } from "../web-client-environment.js";
import type { AccountBrowser } from "./coordinator.js";

/** What recovery reads from where the browser comes from. */
type BrowserSource = Pick<WebClientEnvironment, "openBrowser" | "pageModule">;

const PAGE_MODULES: Record<WebClientVendor, RealUiPageModule> = {
  claude: claudeWebPageModule,
  chatgpt: chatgptWebPageModule,
};
const SIGN_IN_CHECK_MS = 60_000;

/** What `openBrowser` opens; one that can save its profile offers `captureProfile`. */
type OpenedBrowser = Awaited<
  ReturnType<WebClientEnvironment["openBrowser"]>
> & {
  captureProfile?(): Promise<Uint8Array>;
};

export function accountBrowserOver(
  environment: BrowserSource,
  account: { webAccountId: string; vendor: WebClientVendor },
): AccountBrowser & { close(): Promise<void> } {
  const module = environment.pageModule ?? PAGE_MODULES[account.vendor];
  const sites = module.sites.length
    ? module.sites
    : WEB_CLIENT_SITES[account.vendor];
  let opening: Promise<OpenedBrowser> | undefined;
  let opened: OpenedBrowser | undefined;
  const open = async (): Promise<OpenedBrowser> => {
    opening ??= environment.openBrowser({
      webAccountId: account.webAccountId,
      sites,
    });
    return (opened ??= await opening);
  };
  return {
    async verifyAccount() {
      try {
        // Opening can find the account signed out too, before any page loads.
        const { driver } = await open();
        const { email, workspace } = await module.signedIn(driver, {
          timeoutMs: SIGN_IN_CHECK_MS,
        });
        if (!email) return undefined;
        return {
          accountEmail: email,
          ...(workspace ? { workspaceName: workspace } : {}),
        };
      } catch (error) {
        // A page still asking someone to sign in shows no identity to check.
        if (
          error instanceof RealUiError &&
          error.failure.kind === "needs_sign_in"
        ) {
          return undefined;
        }
        throw error;
      }
    },
    async captureProfile() {
      const browser = await open();
      if (!browser.captureProfile) {
        throw new Error("This server can't save a signed-in browser yet.");
      }
      return browser.captureProfile();
    },
    async close() {
      const browser = opened;
      opened = undefined;
      opening = undefined;
      await browser?.close();
    },
  };
}

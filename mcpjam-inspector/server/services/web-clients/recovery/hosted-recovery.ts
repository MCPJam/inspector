/**
 * Recovery as a hosted Inspector runs it: the backend's reconnect requests
 * and tool call ledger, acting as the run's person, and, for a handback, the
 * sign-in browser that person opened from the reconnect page.
 */
import type { WebClientService } from "../backend-connector-resolver.js";
import {
  findSignInBrowser,
  signInBrowserAccount,
} from "../sign-in-browsers.js";
import {
  createConvexLedgerReader,
  createConvexWebReconnectBackend,
} from "./convex-backend.js";
import {
  SignInBrowserAccountMismatchError,
  SignInBrowserNotNamedError,
  type WebRecoverySetup,
} from "./turn-recovery.js";

export function createHostedWebRecovery(
  service: WebClientService,
): WebRecoverySetup {
  return {
    backendFor: ({ actor }) =>
      actor ? createConvexWebReconnectBackend(actor, { service }) : undefined,
    ledger: createConvexLedgerReader(service),
    async handbackEnvironment({ actor, projectId, browserSessionId }) {
      if (!browserSessionId) throw new SignInBrowserNotNamedError();
      const held = { browserSessionId, actor, projectId };
      if (!signInBrowserAccount(held)) return undefined;
      return {
        async openBrowser({ webAccountId }) {
          const browser = findSignInBrowser({ ...held, webAccountId });
          if (!browser) throw new SignInBrowserAccountMismatchError();
          return {
            driver: browser.driver,
            // The person's browser stays theirs; the handback only reads it.
            close: async () => {},
            captureProfile: () => browser.exportProfile(),
          };
        },
      };
    },
  };
}

import type { BrowserComparisonClient } from "@/stores/browser-comparison-store";
import {
  createBrowserTokenCache,
  fetchHostedBrowserState,
  sendHostedPaneCommand,
  type MintBrowserToken,
} from "@/lib/hosted-browser/client";
import {
  fetchLocalBrowserSession,
  fetchLocalBrowserState,
  sendLocalPaneCommand,
} from "@/lib/local-browser/client";
import type { BrowserSessionTransport } from "./use-browser-session";

/** Metadata and explicit commands only: never ensure, watch, resize, or stream. */
export function createComparisonTransport(
  client: BrowserComparisonClient,
  options: {
    holder: string;
    consentToken: string | null;
    mint: MintBrowserToken;
  },
): BrowserSessionTransport {
  if (client.engine === "cloud") {
    const tokens = createBrowserTokenCache(options.mint);
    return {
      readState: () => fetchHostedBrowserState(tokens),
      sendCommand: (command) => sendHostedPaneCommand(tokens, command),
    };
  }
  let bootId: string | null = null;
  return {
    readState: async () => {
      const session = await fetchLocalBrowserSession(
        client.projectId,
        options.consentToken,
        client.sessionId,
      );
      bootId = session?.bootId ?? null;
      return bootId
        ? fetchLocalBrowserState({
            bootId,
            holder: options.holder,
            consentToken: options.consentToken,
          })
        : null;
    },
    sendCommand: (args) =>
      bootId
        ? sendLocalPaneCommand({
            ...args,
            bootId,
            holder: options.holder,
            consentToken: options.consentToken,
          })
        : Promise.resolve({ ok: false, reason: "no_session" }),
  };
}

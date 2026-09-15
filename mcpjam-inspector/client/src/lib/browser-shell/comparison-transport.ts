import type { BrowserComparisonClient } from "@/stores/browser-comparison-store";
import {
  createBrowserTokenCache,
  fetchHostedBrowserState,
  sendHostedPaneCommand,
  actOnHostedBrowserLease,
  HostedBrowserError,
  type MintBrowserToken,
} from "@/lib/hosted-browser/client";
import {
  fetchLocalBrowserSession,
  fetchLocalBrowserState,
  sendLocalPaneCommand,
  actOnLocalBrowserLease,
  LocalBrowserRequestError,
} from "@/lib/local-browser/client";
import type { BrowserSessionTransport } from "./use-browser-session";
import { runBrowserCommandWithHandoff } from "./chat-handoff";

const handoffFailed = () =>
  new Error(
    "Couldn't return browser control to the agent. Try sending your message again.",
  );

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
      sendCommand: (command) =>
        runBrowserCommandWithHandoff({
          projectId: client.projectId,
          sessionId: client.sessionId,
          send: () => sendHostedPaneCommand(tokens, command),
          release: async () => {
            try {
              const result = await actOnHostedBrowserLease(tokens, {
                action: "resume",
              });
              if (!result.took || result.lease.state !== "free")
                throw handoffFailed();
            } catch (error) {
              if (
                error instanceof HostedBrowserError &&
                error.code === "no_browser_session"
              )
                return;
              throw error;
            }
          },
        }),
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
    sendCommand: (args) => {
      // Capture the boot we command: a later metadata read may find a new one.
      const commandBootId = bootId;
      if (!commandBootId)
        return Promise.resolve({ ok: false, reason: "no_session" });
      return runBrowserCommandWithHandoff({
        projectId: client.projectId,
        sessionId: client.sessionId,
        send: () =>
          sendLocalPaneCommand({
            ...args,
            bootId: commandBootId,
            holder: options.holder,
            consentToken: options.consentToken,
          }),
        release: async () => {
          try {
            const result = await actOnLocalBrowserLease(
              {
                bootId: commandBootId,
                holder: options.holder,
                action: "resume",
              },
              options.consentToken,
            );
            if (result.lease.state !== "free") throw handoffFailed();
          } catch (error) {
            if (
              error instanceof LocalBrowserRequestError &&
              error.status === 404
            )
              return;
            throw error;
          }
        },
      });
    },
  };
}

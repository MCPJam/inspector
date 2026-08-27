import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { AppStateProvider } from "@/state/app-state-context";
import { ServerActionsProvider } from "@/state/server-actions-context";
import {
  resetAutoConnectAttempts,
  useAutoConnectProjectServers,
} from "../useAutoConnectProjectServers";

/**
 * Hosted-mode half of the auto-connect hook's candidate filter.
 *
 * Lives in its own file because `HOSTED_MODE` is a build-time constant read
 * through `@/lib/config`, so forcing it on means mocking the module — which
 * is per-file in vitest.
 *
 * What is being pinned: two server shapes CANNOT connect in the cloud
 * deployment (a local stdio command, and cleartext `http://`). Before this,
 * they were attempted anyway, failed in the transport, and painted a red
 * card — for a situation no retry can fix. They must never enter a batch.
 */
vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastLoading: vi.fn(() => "reconnect-toast"),
  toastSuccess: vi.fn(),
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    context: "AutoConnectProjectServers",
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
  },
}));

vi.mock("@/hooks/use-logger", () => ({
  useLogger: () => mocks.logger,
}));

function wrapper({
  children,
  ensureServersReady,
  appState,
}: {
  children: ReactNode;
  ensureServersReady: (names: string[]) => Promise<{
    readyServerNames: string[];
    failedServerNames: string[];
    missingServerNames: string[];
    reauthServerNames: string[];
  }>;
  appState: any;
}) {
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <AppStateProvider appState={appState}>
        <ServerActionsProvider
          actions={{
            ensureServersReady,
            runtimeDisconnectServer: () => {},
            reconnectServer: async () => {},
            setSelectedServerNames: () => {},
          }}
        >
          {children}
        </ServerActionsProvider>
      </AppStateProvider>
    </PreferencesStoreProvider>
  );
}

const flushMicrotasks = () => act(() => Promise.resolve());

describe("useAutoConnectProjectServers (hosted mode)", () => {
  beforeEach(() => {
    resetAutoConnectAttempts();
    localStorage.removeItem("mcpjam-auto-connect-servers");
    mocks.toastError.mockClear();
    mocks.logger.error.mockClear();
  });

  it("excludes stdio and http:// servers from the connect batch", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["secure"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const appState = {
      servers: {
        secure: {
          name: "secure",
          connectionStatus: "disconnected",
          config: { url: "https://example.com/mcp" },
        },
        // Would run a command on OUR infrastructure. Structurally refused.
        local: {
          name: "local",
          connectionStatus: "disconnected",
          config: { command: "npx", args: ["-y", "some-server"] },
        },
        // Cleartext to a server over the public internet. Refused too.
        cleartext: {
          name: "cleartext",
          connectionStatus: "disconnected",
          config: { url: "http://example.com/mcp" },
        },
      },
    } as any;

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-hosted",
          hostScopeKey: "host-a",
          requiredServerNames: ["secure", "local", "cleartext"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState }),
      }
    );

    await flushMicrotasks();

    expect(ensureServersReady).toHaveBeenCalledTimes(1);
    expect(ensureServersReady).toHaveBeenCalledWith(["secure"]);
  });

  it("fires no batch at all when every required server is impossible here", async () => {
    const ensureServersReady = vi.fn();
    const appState = {
      servers: {
        local: {
          name: "local",
          connectionStatus: "disconnected",
          config: { command: "npx" },
        },
      },
    } as any;

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-hosted-empty",
          hostScopeKey: "host-a",
          requiredServerNames: ["local"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState }),
      }
    );

    await flushMicrotasks();

    expect(ensureServersReady).not.toHaveBeenCalled();
  });
});

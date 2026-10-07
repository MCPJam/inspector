import { act, cleanup, render } from "@testing-library/react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewedHostId } from "../hooks/use-previewed-client-id";
import {
  resetAutoConnectAttempts,
  useAutoConnectProjectServers,
} from "../hooks/useAutoConnectProjectServers";
import { AppRouteReactContext } from "../lib/app-route-context";
import { buildHostsPath, useAppNavigate } from "../lib/app-navigation";
import { loadPreviewedHostId } from "../lib/previewed-client-storage";
import { AppStateProvider } from "../state/app-state-context";
import { ServerActionsProvider } from "../state/server-actions-context";

/**
 * The project's previewed client is ONE localStorage value shared by every
 * Inspector tab. Client configuration (`/hosts/:hostId`) used to re-assert its
 * URL's client whenever that value differed, so a second tab that picked
 * another client was overwritten, re-picked, overwritten again… Each flip was a
 * client switch for every other tab: a reconnect of every connected server and
 * a "Reconnected 1 server." toast. This walks the same tabs through one switch
 * and back and counts all of it.
 */
const PROJECT_ID = "project-cross-tab";
const CHATGPT_ID = "kd7n2m5xq9b3tv6yz1r4s0hc";
const CODEX_ID = "w972jy2ak59yymb7s8f12kmgvs8c6xnr";
const SERVER = "pinned";
const PREVIEWED_KEY = "mcp-previewed-host-id";

const mocks = vi.hoisted(() => ({
  hostList: {
    hosts: [] as Array<{ hostId: string; name: string; configId?: string }>,
    isLoading: false,
  },
  toastLoading: vi.fn((..._args: unknown[]) => `toast-${Math.random()}`),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  selectors: new Map<string, (hostId: string) => void>(),
}));

// Client configuration's canvas, reduced to its client picker: switching does
// exactly what `HostCanvasSelector` does — write the previewed client, then
// move the URL to it.
vi.mock("../components/HostsTab", async () => {
  const { createContext, useContext } = await import("react");
  const TabNameContext = createContext("");
  return {
    TabNameContext,
    HostsTab: ({ projectId }: { projectId: string }) => {
      const [, setPreviewedHostId] = usePreviewedHostId(projectId);
      const navigate = useAppNavigate();
      const tab = useContext(TabNameContext);
      mocks.selectors.set(tab, (hostId) => {
        setPreviewedHostId(hostId);
        navigate(buildHostsPath(hostId), { replace: true });
      });
      return null;
    },
  };
});

vi.mock("../hooks/useClients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useClients")>()),
  useHostList: () => mocks.hostList,
  useHostMutations: () => ({
    createHost: vi.fn(),
    updateHostServers: vi.fn(),
    deleteHost: vi.fn(),
    duplicateHost: vi.fn(),
  }),
}));

vi.mock("../hooks/useProjects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useProjects")>()),
  useCanManageProjectClients: () => ({ canManage: true, isLoading: false }),
}));

vi.mock("../lib/toast", () => ({
  toast: {
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
    error: mocks.toastError,
    message: vi.fn(),
  },
}));

vi.mock("../hooks/use-logger", () => ({ useLogger: () => mocks.logger }));

vi.mock("../stores/preferences/preferences-provider", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../stores/preferences/preferences-provider")
  >();
  const state = { themeMode: "dark", autoConnectServersEnabled: true };
  return {
    ...actual,
    usePreferencesStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

// App.tsx's import graph pulls in the CodeMirror JSON editor; stub it so the
// route module loads under jsdom (mirrors the other HostsRoute tests).
vi.mock("../components/ui/json-editor/codemirror-json-editor", () => ({
  CodemirrorJsonEditor: () => null,
}));
vi.mock("@codemirror/lang-json", () => ({ json: () => ({}) }));
vi.mock("@codemirror/view", () => ({
  EditorView: class {},
  lineNumbers: () => ({}),
  highlightActiveLine: () => ({}),
  highlightSpecialChars: () => ({}),
  keymap: () => ({}),
}));
vi.mock("@codemirror/state", () => ({ EditorState: { create: vi.fn() } }));
vi.mock("@codemirror/commands", () => ({
  defaultKeymap: [],
  history: () => ({}),
  historyKeymap: [],
}));
vi.mock("@codemirror/language", () => ({
  bracketMatching: () => ({}),
  foldGutter: () => ({}),
  indentOnInput: () => ({}),
  syntaxHighlighting: () => ({}),
  defaultHighlightStyle: {},
}));
vi.mock("@codemirror/lint", () => ({
  linter: () => ({}),
  lintGutter: () => ({}),
}));

import { HostsRoute } from "../App";
import * as hostsTabModule from "../components/HostsTab";

const { TabNameContext } = hostsTabModule as unknown as {
  TabNameContext: import("react").Context<string>;
};

/** A Client configuration tab sitting on `/hosts/<hostId>`. */
function ClientConfigurationTab({
  name,
  hostId,
}: {
  name: string;
  hostId: string;
}) {
  const context = useMemo(
    () => ({
      convexProjectId: PROJECT_ID,
      hostsTabSelectedHostId: null,
      isAuthenticated: true,
      setHostsTabSelectedHostId: () => {},
      handleReconnect: async () => {},
    }),
    [],
  );
  return (
    <TabNameContext.Provider value={name}>
      <AppRouteReactContext.Provider value={context}>
        <MemoryRouter initialEntries={[buildHostsPath(hostId)]}>
          <Routes>
            <Route path="/hosts/:hostId" element={<HostsRoute />} />
          </Routes>
        </MemoryRouter>
      </AppRouteReactContext.Provider>
    </TabNameContext.Provider>
  );
}

interface PlaygroundLedger {
  reconnects: Array<{ server: string; asClient: string | null }>;
  clients: Array<string | null>;
}

/**
 * A Playground tab, wired the way the real one is: auto-connect is scoped to
 * the previewed client, and a reconnect gives the server a new connection
 * epoch.
 */
function PlaygroundTab({ ledger }: { ledger: PlaygroundLedger }) {
  const [hostId] = usePreviewedHostId(PROJECT_ID);
  const hostIdRef = useRef(hostId);
  hostIdRef.current = hostId;
  if (ledger.clients[ledger.clients.length - 1] !== hostId)
    ledger.clients.push(hostId);
  const [connectedAt, setConnectedAt] = useState(1);
  const [status, setStatus] = useState<"connected" | "connecting">(
    "connected",
  );
  const appState = useMemo(
    () =>
      ({
        servers: {
          [SERVER]: {
            name: SERVER,
            connectionStatus: status,
            lastConnectionTime: new Date(connectedAt),
          },
        },
        selectedMultipleServers: [SERVER],
      }) as never,
    [status, connectedAt],
  );
  const actions = useMemo(
    () => ({
      ensureServersReady: async () => ({
        readyServerNames: [],
        failedServerNames: [],
        missingServerNames: [],
        reauthServerNames: [],
      }),
      runtimeDisconnectServer: () => {},
      setSelectedServerNames: () => {},
      reconnectServer: async (name: string) => {
        ledger.reconnects.push({ server: name, asClient: hostIdRef.current });
        setStatus("connecting");
        await Promise.resolve();
        setConnectedAt((at) => at + 1);
        setStatus("connected");
      },
    }),
    [ledger],
  );
  return (
    <AppStateProvider appState={appState}>
      <ServerActionsProvider actions={actions}>
        <PlaygroundCenter hostId={hostId} />
      </ServerActionsProvider>
    </AppStateProvider>
  );
}

function PlaygroundCenter({ hostId }: { hostId: string | null }) {
  useAutoConnectProjectServers({
    projectId: PROJECT_ID,
    hostScopeKey: hostId,
    serverNames: [SERVER],
  });
  return null;
}

function Tabs({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function newLedger(): PlaygroundLedger {
  return { reconnects: [], clients: [] };
}

/** Let effects, storage events and the fake reconnects settle. */
async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Another browser tab wrote the project's previewed client. */
function writeFromAnotherTab(hostId: string) {
  const all = JSON.parse(localStorage.getItem(PREVIEWED_KEY) ?? "{}");
  all[PROJECT_ID] = hostId;
  const newValue = JSON.stringify(all);
  localStorage.setItem(PREVIEWED_KEY, newValue);
  lastPreviewed = hostId;
  window.dispatchEvent(
    new StorageEvent("storage", { key: PREVIEWED_KEY, newValue }),
  );
}

// Counts every change of the previewed client (a write of the value already
// stored changes nothing, and fires no `storage` event in other tabs).
// Registered before any tab subscribes, so a runaway loop is cut off here —
// past the cap a change never reaches the tabs — and the count assertions fail
// cleanly instead of the worker running out of memory.
//
// Every "tab" here shares one window, where a write reaches the others
// synchronously. Between real tabs it arrives later, as a `storage` event — so
// with `acrossTabs` on, a change is held back and redelivered that way, which
// lets reconnects finish between flips exactly as they did in the browser.
const MAX_PREVIEWED_WRITES = 40;
let previewedWrites = 0;
let lastPreviewed: string | null = null;
let acrossTabs = false;
const countWrite = (event: Event) => {
  const { hostId } = (event as CustomEvent<{ hostId: string | null }>).detail;
  if (hostId === lastPreviewed) return;
  lastPreviewed = hostId;
  if (++previewedWrites > MAX_PREVIEWED_WRITES) {
    event.stopImmediatePropagation();
    return;
  }
  if (!acrossTabs) return;
  event.stopImmediatePropagation();
  setTimeout(() =>
    window.dispatchEvent(new StorageEvent("storage", { key: PREVIEWED_KEY })),
  );
};

beforeEach(() => {
  localStorage.clear();
  resetAutoConnectAttempts();
  mocks.hostList.hosts = [
    { hostId: CHATGPT_ID, name: "ChatGPT" },
    { hostId: CODEX_ID, name: "Codex" },
  ];
  mocks.hostList.isLoading = false;
  mocks.selectors.clear();
  previewedWrites = 0;
  lastPreviewed = CHATGPT_ID;
  acrossTabs = false;
  window.addEventListener("previewed-host-changed", countWrite);
  // The Playground was already on ChatGPT before any of this.
  localStorage.setItem(
    PREVIEWED_KEY,
    JSON.stringify({ [PROJECT_ID]: CHATGPT_ID }),
  );
});

afterEach(() => {
  cleanup();
  window.removeEventListener("previewed-host-changed", countWrite);
  vi.clearAllMocks();
});

describe("Client configuration — a client picked in another tab", () => {
  it("is not overwritten with this tab's URL client", async () => {
    render(<ClientConfigurationTab name="config" hostId={CHATGPT_ID} />);
    await settle();
    // Opening the page on ChatGPT already matched; nothing to write.
    expect(previewedWrites).toBe(0);

    writeFromAnotherTab(CODEX_ID);
    await settle();

    // The other tab's choice stands: this tab does not write ChatGPT back.
    expect(loadPreviewedHostId(PROJECT_ID)).toBe(CODEX_ID);
    expect(previewedWrites).toBe(0);
  });

  it("still makes the URL's client the previewed one when the page opens on it", async () => {
    render(<ClientConfigurationTab name="config" hostId={CODEX_ID} />);
    await settle();
    expect(loadPreviewedHostId(PROJECT_ID)).toBe(CODEX_ID);
    expect(previewedWrites).toBe(1);
  });
});

describe("one client switch across tabs", () => {
  it("reconnects each server once and shows one toast per switch", async () => {
    acrossTabs = true;
    const playground = newLedger();
    // Tab 1: the Playground on ChatGPT. Tabs 2 and 3: Client configuration,
    // both opened on ChatGPT (one was used to edit its toggles earlier).
    render(
      <Tabs>
        <PlaygroundTab ledger={playground} />
        <ClientConfigurationTab name="stale-config" hostId={CHATGPT_ID} />
        <ClientConfigurationTab name="config" hostId={CHATGPT_ID} />
      </Tabs>,
    );
    await settle();
    expect(playground.reconnects).toHaveLength(0);
    previewedWrites = 0;

    // Tab 3 picks the Codex client.
    await act(async () => {
      mocks.selectors.get("config")!(CODEX_ID);
    });
    await settle();

    expect(loadPreviewedHostId(PROJECT_ID)).toBe(CODEX_ID);
    // Exactly one write of the new client, and nobody writes it back.
    expect(previewedWrites).toBe(1);
    expect(playground.clients).toEqual([CHATGPT_ID, CODEX_ID]);
    // One reconnect of the one connected server, under the new client.
    expect(playground.reconnects).toEqual([
      { server: SERVER, asClient: CODEX_ID },
    ]);
    expect(mocks.toastLoading).toHaveBeenCalledTimes(1);
    expect(mocks.toastLoading).toHaveBeenCalledWith("Reconnecting 1 server…");
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Reconnected 1 server.",
      expect.anything(),
    );

    // And back to ChatGPT, from the same tab.
    await act(async () => {
      mocks.selectors.get("config")!(CHATGPT_ID);
    });
    await settle();

    expect(loadPreviewedHostId(PROJECT_ID)).toBe(CHATGPT_ID);
    expect(previewedWrites).toBe(2);
    expect(playground.clients).toEqual([CHATGPT_ID, CODEX_ID, CHATGPT_ID]);
    expect(playground.reconnects).toEqual([
      { server: SERVER, asClient: CODEX_ID },
      { server: SERVER, asClient: CHATGPT_ID },
    ]);
    expect(mocks.toastLoading).toHaveBeenCalledTimes(2);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("does not reconnect when the client's settings are saved without switching", async () => {
    acrossTabs = true;
    const playground = newLedger();
    const { rerender } = render(
      <Tabs>
        <PlaygroundTab ledger={playground} />
        <ClientConfigurationTab name="config" hostId={CHATGPT_ID} />
      </Tabs>,
    );
    await settle();
    previewedWrites = 0;

    // A toggles-only save: the client list re-emits with a new config id for
    // the same client.
    mocks.hostList = {
      ...mocks.hostList,
      hosts: mocks.hostList.hosts.map((host) =>
        host.hostId === CHATGPT_ID ? { ...host, configId: "next" } : host,
      ),
    };
    rerender(
      <Tabs>
        <PlaygroundTab ledger={playground} />
        <ClientConfigurationTab name="config" hostId={CHATGPT_ID} />
      </Tabs>,
    );
    await settle();

    expect(previewedWrites).toBe(0);
    expect(playground.reconnects).toHaveLength(0);
    expect(mocks.toastLoading).not.toHaveBeenCalled();
  });
});

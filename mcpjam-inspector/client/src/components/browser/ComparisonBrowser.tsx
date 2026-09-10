import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBrowserComparisonStore } from "@/stores/browser-comparison-store";
import { useBrowserEngine } from "@/hooks/useBrowserEngine";
import { useMintConversationBrowserToken } from "@/hooks/useProjectComputer";
import { usePaneHolderId } from "@/lib/local-browser/pane-holder";
import { createComparisonTransport } from "@/lib/browser-shell/comparison-transport";
import type { BrowserStateSnapshot } from "@/shared/browser-session-state";
import type { BrowserPaneCommand } from "@/shared/browser-pane-command";
import { BrowserTabStrip, type BrowserDisplayTab } from "./BrowserTabStrip";
import { BrowserWorkspaceChrome } from "./BrowserWorkspaceChrome";
import { LocalBrowserBody } from "./LocalBrowserBody";
import { HostedBrowserBody } from "./HostedBrowserBody";
import { LocalBrowserConsentGate } from "./LocalBrowserConsentGate";
import { HOSTED_MODE } from "@/lib/config";

type SessionView = { snapshot: BrowserStateSnapshot | null; stale: boolean };
const tabKey = (sessionId: string, tabId: string) =>
  JSON.stringify([sessionId, tabId]);

/** One strip over isolated browsers; only the selected browser gets a renderer. */
export function ComparisonBrowser({
  projectId,
  workspaceId,
  active,
}: {
  projectId: string;
  workspaceId: string;
  active: boolean;
}) {
  const registered = useBrowserComparisonStore((state) => state.clients);
  const selectedId = useBrowserComparisonStore(
    (state) => state.selected[workspaceId],
  );
  const clients = useMemo(
    () =>
      Object.values(registered)
        .filter(
          (client) =>
            client.workspaceId === workspaceId &&
            client.projectId === projectId,
        )
        .sort((a, b) => a.order - b.order),
    [registered, workspaceId, projectId],
  );
  const showNames = clients.some((client) => client.clientCount > 1);
  const selected = clients.find((client) => client.sessionId === selectedId);
  const engine = useBrowserEngine(projectId);
  const mint = useMintConversationBrowserToken();
  const mintRef = useRef(mint);
  mintRef.current = mint;
  const holder = usePaneHolderId();
  const [views, setViews] = useState<Record<string, SessionView>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const transports = useMemo(
    () =>
      new Map(
        clients
          .filter(
            (client) =>
              client.started &&
              (client.engine !== "local" || engine.consent.granted),
          )
          .map((client) => [
            client.sessionId,
            createComparisonTransport(client, {
              holder,
              consentToken: engine.consent.token,
              mint: () =>
                mintRef.current({
                  projectId,
                  conversationId: client.sessionId,
                }),
            }),
          ]),
      ),
    [clients, holder, engine.consent.granted, engine.consent.token, projectId],
  );
  // A generation guards both metadata reads and user commands across resets.
  const current = useRef(transports);
  current.current = transports;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // Each session schedules its own next read: one unreachable browser must
    // not stall metadata updates for all the other clients.
    const timers = new Set<ReturnType<typeof setTimeout>>();
    for (const [id, transport] of transports) {
      const tick = async () => {
        if (document.visibilityState === "visible") {
          const snapshot = await transport.readState().catch(() => null);
          if (cancelled) return;
          setViews((previous) => ({
            ...previous,
            [id]: {
              snapshot: snapshot ?? previous[id]?.snapshot ?? null,
              stale: !snapshot,
            },
          }));
        }
        if (!cancelled) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            void tick();
          }, 2_000);
          timers.add(timer);
        }
      };
      void tick();
    }
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [transports, active]);
  useEffect(() => {
    setError(null);
    setBusy(false);
    setViews((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([id]) =>
          clients.some((client) => client.sessionId === id),
        ),
      ),
    );
  }, [clients]);

  const command = async (
    id: string,
    value: BrowserPaneCommand,
    selectAfter = false,
  ) => {
    const transport = transports.get(id);
    if (!transport) return;
    setBusy(true);
    setError(null);
    try {
      const result = await transport.sendCommand({ command: value });
      if (current.current !== transports) return;
      if (!result.ok) {
        setError(
          result.reason === "lease_held"
            ? "Someone else has control of this browser."
            : result.reason === "no_session"
            ? "This browser is no longer running."
            : "The browser could not complete that action. Try again.",
        );
        return;
      }
      const snapshot = await transport.readState();
      if (current.current !== transports) return;
      if (snapshot)
        setViews((previous) => ({
          ...previous,
          [id]: { snapshot, stale: false },
        }));
      if (selectAfter)
        useBrowserComparisonStore.getState().select(workspaceId, id);
    } catch {
      if (current.current === transports)
        setError("Could not reach this browser. Try again.");
    } finally {
      if (current.current === transports) setBusy(false);
    }
  };
  const rows = clients
    .filter((client) => client.started)
    .flatMap((client) => {
      const snapshot = views[client.sessionId]?.snapshot;
      const tabs = snapshot?.tabs.length
        ? snapshot.tabs
        : [
            {
              id: "",
              url: "",
              title: views[client.sessionId]?.stale
                ? "Reconnecting…"
                : snapshot
                ? "No open tabs"
                : "Connecting…",
              loading: !snapshot,
            },
          ];
      return tabs.map(
        (tab) =>
          ({
            ...tab,
            id: tabKey(client.sessionId, tab.id),
            sessionId: client.sessionId,
            tabId: tab.id,
            clientName: showNames ? client.name : undefined,
            clientLogo: showNames ? client.logo : undefined,
            unavailable: !tab.id,
          } satisfies BrowserDisplayTab & { sessionId: string; tabId: string }),
      );
    });
  const selectedView = selectedId ? views[selectedId] : undefined;
  const mintSelected = useCallback(
    ({ projectId: id }: { projectId: string }) => {
      if (!selectedId) throw new Error("No browser selected.");
      return mintRef.current({ projectId: id, conversationId: selectedId });
    },
    [selectedId],
  );
  const chrome = useMemo(
    () => ({
      clientName: showNames ? selected?.name : undefined,
      holderId: holder,
    }),
    [showNames, selected?.name, holder],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="comparison-browser"
    >
      <BrowserTabStrip
        tabs={rows}
        activeTabId={
          selectedId
            ? tabKey(selectedId, selectedView?.snapshot?.activeTabId ?? "")
            : null
        }
        disabled={!active || busy}
        newTabDisabled={!selectedView?.snapshot || selectedView.stale}
        onActivate={(key) => {
          const row = rows.find((tab) => tab.id === key);
          if (!row) return;
          setError(null);
          if (
            !row.tabId ||
            views[row.sessionId]?.snapshot?.activeTabId === row.tabId
          ) {
            useBrowserComparisonStore
              .getState()
              .select(workspaceId, row.sessionId);
          } else
            void command(
              row.sessionId,
              { op: "activate_tab", tabId: row.tabId },
              true,
            );
        }}
        onClose={(key) => {
          const row = rows.find((tab) => tab.id === key);
          if (row?.tabId)
            void command(row.sessionId, { op: "close_tab", tabId: row.tabId });
        }}
        onNewTab={() => {
          if (selectedId) void command(selectedId, { op: "create_tab" });
        }}
      />
      {error && (
        <p role="alert" className="px-3 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {selectedView?.stale && (
        <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
          {showNames
            ? `Reconnecting to ${selected?.name}…`
            : "Reconnecting to browser…"}
        </p>
      )}
      <BrowserWorkspaceChrome.Provider value={chrome}>
        {!HOSTED_MODE &&
        (selected?.engine ?? engine.selectedEngine) === "local" &&
        engine.localAvailable &&
        !engine.consent.granted ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <LocalBrowserConsentGate
              onAllow={engine.consent.grant}
              location="playground_browser"
            />
          </div>
        ) : selected && selectedView?.snapshot ? (
          selected.engine === "local" ? (
            <LocalBrowserBody
              key={selected.sessionId}
              projectId={projectId}
              sessionId={selected.sessionId}
              consentGranted={engine.consent.granted}
              consentToken={engine.consent.token}
              active={active}
            />
          ) : (
            <HostedBrowserBody
              key={selected.sessionId}
              projectId={projectId}
              sessionId={selected.sessionId}
              mintToken={mintSelected}
              active={active}
            />
          )
        ) : (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            {selected
              ? selected.engine === "local" && !engine.consent.granted
                ? "Allow local browser access in Browser settings to view this client."
                : showNames
                ? `Connecting to ${selected.name}’s browser…`
                : "Connecting to browser…"
              : "Waiting for a client to browse…"}
          </p>
        )}
      </BrowserWorkspaceChrome.Provider>
    </div>
  );
}

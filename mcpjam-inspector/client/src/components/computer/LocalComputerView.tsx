import { useCallback, useEffect, useRef } from "react";
import { Laptop, FolderTree } from "lucide-react";
import { track } from "@/lib/analytics";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import type { ComputerEngineState } from "@/hooks/useComputerEngine";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { mintLocalTerminalNonce } from "@/lib/local-computer-consent";
import { LOCAL_TERMINAL_WS_PATH } from "@/lib/computer-terminal-connection";
import { ComputerTerminal } from "./ComputerTerminal";
import { LocalComputerConsentGate } from "./LocalComputerConsentGate";
import { PaneMessage } from "./PaneMessage";

/**
 * The "This machine" face of the Computer tab: agents run bash on the computer
 * the inspector is running on, in a per-project workspace directory. Always
 * ready — no sleep/wake/image/billing. Shown only for a signed-in member on a
 * non-hosted inspector when the local engine is SELECTED (see `ComputerTabView`).
 *
 * The interactive terminal is a real PTY on this machine (node-pty), reached
 * over `/api/web/computers/local-terminal` with a single-use nonce minted
 * against the consent capability. When node-pty isn't installable (no build
 * toolchain, or the packaged Electron app, which carries no node_modules)
 * `engine.localTerminalAvailable` stays false and this degrades to a note —
 * bash from chat still works.
 */
export function LocalComputerView({
  projectId,
  engine,
}: {
  projectId: string;
  engine: ComputerEngineState;
}) {
  const { consent, setEngine, cloudAvailable, localTerminalAvailable } = engine;
  const workspaceDir = engine.workspaceDisplayRoot
    ? `${engine.workspaceDisplayRoot}/${projectId}`
    : null;

  // Registered while THIS face is mounted (ComputerView's real bridge is
  // unmounted meanwhile). The cloud-lifecycle verbs don't apply to the local
  // machine, so they refuse rather than vanish from the catalog mid-session.
  useSurfaceAgentBridge({
    surfaceId: "computer",
    handlers: {
      startComputer: refuseLocal,
      hibernateComputer: refuseLocal,
      resetComputer: refuseLocal,
      deleteComputer: refuseLocal,
    },
    snapshot: () => ({
      engine: "local" as const,
      consentGranted: consent.granted,
      terminalAvailable: localTerminalAvailable,
      workspaceDir,
    }),
  });

  const themeMode = usePreferencesStore((state) => state.themeMode);

  // A fresh nonce per (re)connect — it is single-use by construction, so the
  // reconnect button in `ComputerTerminal` must mint again rather than replay.
  const consentToken = consent.token;
  const mintToken = useCallback(
    () => mintLocalTerminalNonce({ projectId, consentToken }),
    [projectId, consentToken],
  );

  // One `computer_terminal_opened` per mounted local pane (not per reconnect),
  // and one `local_terminal_unavailable` per degraded mount — content-free
  // either way.
  const showTerminal = consent.granted && localTerminalAvailable;
  const showDegraded = consent.granted && !localTerminalAvailable;
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    const key = showTerminal ? "open" : showDegraded ? "degraded" : null;
    if (key === null || lastReportedRef.current === key) return;
    lastReportedRef.current = key;
    if (key === "open") {
      track("computer_terminal_opened", { location: "computer_tab_local" });
    } else {
      track("local_terminal_unavailable", { reason: "terminal_unavailable" });
    }
  }, [showTerminal, showDegraded]);

  const onAllow = async (): Promise<boolean> => {
    const ok = await consent.grant();
    // Persist the preference too, so the resolved engine sticks at local for
    // chat/rail even after a reload — grant alone flips `granted`, this pins it.
    if (ok) setEngine("local");
    return ok;
  };

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-foreground">Computer</h1>
        <span
          className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground"
          data-testid="this-machine-chip"
        >
          <Laptop className="size-3.5" aria-hidden />
          This machine
        </span>
      </div>

      <p className="text-sm leading-relaxed text-muted-foreground">
        Agents run commands directly on this machine — the same computer the
        inspector is running on. Commands run as your user, in the working
        directory below. Nothing to start or wake; it&apos;s always ready.
      </p>

      {workspaceDir ? (
        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-sm">
          <FolderTree className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">Working directory:</span>
          <span className="truncate font-mono text-foreground">
            {workspaceDir}
          </span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {!consent.granted ? (
          <LocalComputerConsentGate
            onAllow={onAllow}
            {...(cloudAvailable
              ? { onUseCloud: () => setEngine("cloud") }
              : {})}
          />
        ) : localTerminalAvailable ? (
          // `uploadEnabled={false}`: the pane's drag-and-drop upload posts to
          // the CLOUD box's upload route, which would burn this pane's
          // single-use nonce against the wrong endpoint and toast a failure.
          // Writing dropped files onto the user's real filesystem is a separate
          // consent question, deliberately out of scope here.
          <ComputerTerminal
            mintToken={mintToken}
            themeMode={themeMode === "dark" ? "dark" : "light"}
            wsPath={LOCAL_TERMINAL_WS_PATH}
            uploadEnabled={false}
            className="h-full"
          />
        ) : (
          <PaneMessage dashed>
            The terminal for this machine isn&apos;t available yet. Agents can
            already run bash commands here from chat.
          </PaneMessage>
        )}
      </div>

      {consent.granted ? (
        // Recovery path: the stored capability can go stale (another browser
        // profile re-granted, or the server-side consent file was removed) —
        // `granted` only reflects a stored token, so without this the gate
        // would never return. Forgetting clears it (and best-effort revokes on
        // the server), which re-shows the consent gate to re-authorize.
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Agent commands are allowed on this machine.</span>
          <button
            type="button"
            data-testid="local-computer-reauthorize"
            className="font-medium text-primary hover:underline"
            onClick={() => {
              track("local_computer_consent_reauthorized", {
                location: "computer_tab_local",
              });
              void consent.revoke();
            }}
          >
            Forget &amp; re-authorize
          </button>
        </div>
      ) : null}
    </div>
  );
}

function refuseLocal(): never {
  throw createInspectorCommandClientError(
    "unsupported_in_mode",
    "The computer engine is set to 'This machine' — start/hibernate/reset/delete only apply to the cloud computer. Switch the toggle to Cloud to manage it.",
  );
}

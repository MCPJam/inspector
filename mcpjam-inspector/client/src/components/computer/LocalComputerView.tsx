import { Laptop, FolderTree } from "lucide-react";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import type { ComputerEngineState } from "@/hooks/useComputerEngine";
import { LocalComputerConsentGate } from "./LocalComputerConsentGate";
import { PaneMessage } from "./PaneMessage";

/**
 * The "This machine" face of the Computer tab: agents run bash on the computer
 * the inspector is running on, in a per-project workspace directory. Always
 * ready — no sleep/wake/image/billing. Shown only for a signed-in member on a
 * non-hosted inspector when the local engine is SELECTED (see `ComputerTabView`).
 *
 * The interactive terminal lands in a later PR (node-pty); until
 * `engine.localTerminalAvailable` flips true this shows a terminal-unavailable
 * note — bash from chat already works.
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
          // The node-pty terminal PR wires the real pane here; until then this
          // branch is unreachable (terminalAvailable is false).
          <PaneMessage>Terminal ready.</PaneMessage>
        ) : (
          <PaneMessage dashed>
            The terminal for this machine isn&apos;t available yet. Agents can
            already run bash commands here from chat.
          </PaneMessage>
        )}
      </div>
    </div>
  );
}

function refuseLocal(): never {
  throw createInspectorCommandClientError(
    "unsupported_in_mode",
    "The computer engine is set to 'This machine' — start/hibernate/reset/delete only apply to the cloud computer. Switch the toggle to Cloud to manage it.",
  );
}

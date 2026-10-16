import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import type { LocalHarnessControllerState } from "@/hooks/useLocalHarnessTarget";
import { stopAllLocalHarnessSessions } from "@/lib/local-harness-consent";
import { LocalHarnessComposerNotice } from "./LocalHarnessComposerNotice";

type PanelState = Pick<
  LocalHarnessControllerState,
  | "phase"
  | "harnessName"
  | "runtimeStatus"
  | "statusFetchFailed"
  | "reason"
  | "requestedTarget"
  | "revoke"
  | "refresh"
> & {
  consent: object | null;
  availability: { unattendedGit?: { ready: boolean; message: string } } | null;
};

function useLocalHarnessControls(controller: PanelState) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function control(action: "stop" | "forget") {
    setBusy(true);
    setError(null);
    try {
      if (action === "stop") {
        if (!(await stopAllLocalHarnessSessions())) {
          setError("Local sessions could not be stopped. Try again.");
        }
      } else {
        await controller.revoke();
        controller.refresh();
      }
    } catch {
      setError("Local access could not be removed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, control };
}

export function LocalHarnessComposerPanel({
  controller,
  progress,
  onRetry,
  onSetup,
}: {
  controller: PanelState;
  progress: string | null;
  onRetry: () => void;
  onSetup: () => void;
}) {
  const { busy, error, control } = useLocalHarnessControls(controller);
  const git = controller.availability?.unattendedGit;
  const authorized = controller.consent !== null;
  const canForget =
    controller.consent !== null ||
    controller.requestedTarget === "local-native" ||
    progress !== null;
  const runtime =
    progress ??
    (controller.phase === "ready" || controller.runtimeStatus?.state === "ready"
      ? "Ready"
      : "Not ready");

  return (
    <div className="space-y-2">
      <LocalHarnessComposerNotice
        controller={controller}
        onRetry={onRetry}
        onSetup={onSetup}
      />
      <ul
        className="space-y-1 px-3 text-xs text-muted-foreground"
        aria-label="Local setup checklist"
        aria-live="polite"
      >
        <li>Runtime: {runtime}</li>
        <li>Authorization: {authorized ? "Allowed" : "Not authorized"}</li>
        <li>Git for evals and swarms: {git?.message ?? "Not checked"}</li>
      </ul>
      <div className="flex gap-2 px-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void control("stop")}
        >
          Stop all local sessions
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !canForget}
          onClick={() => void control("forget")}
          title="Remove local client authorization for this project"
        >
          Forget local access
        </Button>
      </div>
      {error ? (
        <p role="alert" className="px-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

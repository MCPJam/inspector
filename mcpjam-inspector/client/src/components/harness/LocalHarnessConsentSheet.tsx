import { useEffect, useState } from "react";
import { Download, FolderOpen, ShieldQuestion } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import {
  fetchLocalHarnessRuntimeStatus,
  installLocalHarnessRuntime,
  mintLocalHarnessConsent,
  persistLocalHarnessConsent,
  registerLocalHarnessWorkspace,
  revokeLocalHarnessConsent,
  type LocalHarnessAvailabilityView,
  type StoredLocalHarnessConsent,
} from "@/lib/local-harness-consent";

/**
 * First-run consent for running Claude Code natively on this machine.
 *
 * Three steps, in the order the guarantees depend on each other: install the
 * verified runtime, choose the folder the agent may work in, then agree.
 * Consent is minted LAST because it binds to the runtime's digest and the
 * workspace's id — a grant minted before either exists would be a grant to
 * something unspecified.
 *
 * The copy is deliberately blunt about the one thing that matters: this is not
 * a sandbox. `targetHasHostContainment()` answers false for `local-native` no
 * matter how narrow the permission profile, how confined the file API, or how
 * tidy the synthetic home — those reduce accidents, none of them contains a
 * process running as the OS user. The consent sheet says so in those words.
 */
export function LocalHarnessConsentSheet({
  projectId,
  availability,
  existingConsent,
  onGranted,
  onUseHosted,
  onRefresh,
  location = "harness_target_sheet",
}: {
  projectId: string;
  availability: LocalHarnessAvailabilityView | null;
  existingConsent: StoredLocalHarnessConsent | null;
  onGranted: (consent: StoredLocalHarnessConsent) => void;
  onUseHosted?: () => void;
  onRefresh: () => void;
  location?: string;
}) {
  const [workspace, setWorkspace] = useState<{
    workspaceGrantId: string;
    displayRoot: string;
  } | null>(
    existingConsent
      ? {
          workspaceGrantId: existingConsent.target.workspaceGrantId,
          displayRoot: existingConsent.workspaceDisplayRoot,
        }
      : null,
  );
  const [pathDraft, setPathDraft] = useState("");
  const [busy, setBusy] = useState<
    "idle" | "installing" | "picking" | "granting"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState(
    availability?.runtimeStatus ?? null,
  );

  const runtimeReady = runtimeStatus?.state === "ready";

  // Content-free funnel: shown → granted | denied.
  useEffect(() => {
    track("local_harness_consent_gate_shown", {
      location,
      runtime_ready: runtimeReady,
      hosted_offered: Boolean(onUseHosted),
    });
    // Deliberately once per mount: this is the "the sheet appeared" event, not
    // "the sheet re-rendered".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleInstall = async () => {
    setBusy("installing");
    setError(null);
    track("local_harness_runtime_install_started", { location });
    // Poll while the install runs: the route resolves only when it finishes,
    // and a ~200 MB download with no visible progress reads as a hang.
    const poll = window.setInterval(() => {
      void fetchLocalHarnessRuntimeStatus().then((status) => {
        if (status !== null) setRuntimeStatus(status);
      });
    }, 750);
    try {
      const result = await installLocalHarnessRuntime();
      setRuntimeStatus(result);
      if (result?.state === "ready") {
        track("local_harness_runtime_install_completed", { location });
        onRefresh();
      } else {
        // The status enum, never the installer's message — it can carry a path.
        track("local_harness_runtime_install_failed", {
          location,
          state: result?.state ?? "unknown",
        });
        setError(
          "The local runtime could not be installed. Check your connection " +
            "and try again.",
        );
      }
    } finally {
      window.clearInterval(poll);
      setBusy("idle");
    }
  };

  const handlePickFolder = async () => {
    setBusy("picking");
    setError(null);
    try {
      // On the desktop app the picker runs in the MAIN process and registers
      // the grant itself, so the renderer never sees or sends a path. On npx
      // the user types one into their own loopback server.
      const electron = (
        window as unknown as {
          electronAPI?: {
            localHarness?: {
              pickWorkspace: () => Promise<{
                workspaceGrantId: string;
                displayRoot: string;
              } | null>;
            };
          };
        }
      ).electronAPI?.localHarness;
      const picked = electron
        ? await electron.pickWorkspace()
        : pathDraft.trim().length > 0
          ? await registerLocalHarnessWorkspace(pathDraft.trim())
          : null;
      if (picked === null) {
        if (!electron && pathDraft.trim().length === 0) {
          setError("Enter the folder the agent should work in.");
        } else {
          setError("That folder could not be used. Pick another one.");
        }
        return;
      }
      setWorkspace(picked);
    } finally {
      setBusy("idle");
    }
  };

  const handleAllow = async () => {
    if (workspace === null) return;
    setBusy("granting");
    setError(null);
    try {
      const minted = await mintLocalHarnessConsent({
        projectId,
        workspaceGrantId: workspace.workspaceGrantId,
      });
      if (minted === null) {
        track("local_harness_consent_granted", { location, outcome: "failed" });
        setError(
          "Couldn't authorize local execution. Check that you're signed in " +
            "and try again.",
        );
        return;
      }
      const stored = persistLocalHarnessConsent(projectId, minted);
      track("local_harness_consent_granted", {
        location,
        outcome: stored ? "stored" : "failed",
      });
      if (!stored) {
        // A grant the UI cannot read back would resolve the target local while
        // no header exists to send, so it is not treated as consent.
        setError(
          "Your browser wouldn't store the authorization, so local execution " +
            "stays off.",
        );
        return;
      }
      onGranted(minted);
    } finally {
      setBusy("idle");
    }
  };

  const handleForget = async () => {
    track("local_harness_consent_reauthorized", { location });
    await revokeLocalHarnessConsent(projectId);
    setWorkspace(null);
    onRefresh();
  };

  return (
    <div
      data-testid="local-harness-consent-sheet"
      className="mx-auto flex max-w-lg flex-col gap-4 rounded-lg border border-border/60 bg-muted/20 px-6 py-6"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <ShieldQuestion className="size-6 text-muted-foreground" aria-hidden />
        <h2 className="text-base font-semibold text-foreground">
          Run Claude Code on this machine?
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Claude Code will run as a real process on this computer, as your user
          account. The folder you pick is where it starts — it is{" "}
          <span className="font-medium text-foreground">not a sandbox</span>.
          Anything your user can read or change, it can read or change. Edits
          inside the folder run freely; commands still ask for approval in chat.
        </p>
      </div>

      <ol className="flex flex-col gap-3 text-sm">
        <li className="flex items-start gap-3">
          <StepMarker done={runtimeReady} n={1} />
          <div className="flex-1">
            <div className="font-medium text-foreground">
              Install the local runtime
            </div>
            <p className="text-xs text-muted-foreground">
              A verified copy of Claude Code and its runtime, about 200 MB.
              MCPJam checks its signature and its contents before anything runs.
            </p>
            {runtimeReady ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Installed
                {runtimeStatus?.packVersion
                  ? ` · pack ${runtimeStatus.packVersion}`
                  : ""}
                {availability?.runtime
                  ? ` · adapter ${availability.runtime.adapterVersion}`
                  : ""}
              </p>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => void handleInstall()}
                  disabled={busy !== "idle"}
                  className="gap-2"
                >
                  <Download className="size-3.5" aria-hidden />
                  {busy === "installing"
                    ? runtimeStatus?.state === "downloading"
                      ? `Downloading ${runtimeStatus.percent ?? 0}%`
                      : runtimeStatus?.state === "verifying"
                        ? "Verifying…"
                        : "Installing…"
                    : "Install local runtime"}
                </Button>
              </div>
            )}
          </div>
        </li>

        <li className="flex items-start gap-3">
          <StepMarker done={workspace !== null} n={2} />
          <div className="flex-1">
            <div className="font-medium text-foreground">
              Choose the project folder
            </div>
            {workspace !== null ? (
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {workspace.displayRoot}
              </p>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                {!(window as unknown as { isElectron?: boolean }).isElectron ? (
                  <input
                    className="min-w-0 flex-1 rounded border border-border/60 bg-background px-2 py-1 font-mono text-xs"
                    placeholder="~/code/your-project"
                    value={pathDraft}
                    onChange={(event) => setPathDraft(event.target.value)}
                    disabled={busy !== "idle"}
                  />
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handlePickFolder()}
                  disabled={busy !== "idle"}
                  className="gap-2"
                >
                  <FolderOpen className="size-3.5" aria-hidden />
                  {busy === "picking" ? "Choosing…" : "Choose folder"}
                </Button>
              </div>
            )}
          </div>
        </li>

        <li className="flex items-start gap-3">
          <StepMarker done={false} n={3} />
          <div className="flex-1">
            <div className="font-medium text-foreground">Authorize</div>
            <p className="text-xs text-muted-foreground">
              This authorization is for this project and this machine, and
              expires on its own. Changing the runtime, the folder or the
              permission profile requires authorizing again.
            </p>
          </div>
        </li>
      </ol>

      {availability?.runtime ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border border-border/50 bg-background/40 p-3 text-xs">
          <dt className="text-muted-foreground">Runtime</dt>
          <dd className="font-mono text-foreground">
            {availability.runtime.adapterVersion}
          </dd>
          <dt className="text-muted-foreground">Digest</dt>
          <dd className="truncate font-mono text-foreground">
            {availability.runtime.digest}
          </dd>
          <dt className="text-muted-foreground">Permissions</dt>
          <dd className="text-foreground">
            {availability.permissionProfile === "workspace-edits"
              ? "Edits in the folder run freely; commands ask for approval"
              : availability.permissionProfile}
          </dd>
          {availability.keyFingerprint ? (
            <>
              <dt className="text-muted-foreground">This installation</dt>
              <dd className="font-mono text-foreground">
                {availability.keyFingerprint}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      <div className="flex items-center justify-center gap-2">
        <Button
          size="sm"
          onClick={() => void handleAllow()}
          disabled={busy !== "idle" || !runtimeReady || workspace === null}
        >
          {busy === "granting" ? "Authorizing…" : "Allow"}
        </Button>
        {onUseHosted ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== "idle"}
            onClick={() => {
              track("local_harness_consent_denied", { location });
              onUseHosted();
            }}
          >
            Run hosted instead
          </Button>
        ) : null}
        {existingConsent !== null ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== "idle"}
            onClick={() => void handleForget()}
          >
            Forget &amp; re-authorize
          </Button>
        ) : null}
      </div>

      {error !== null ? (
        <p
          className="text-center text-xs text-destructive"
          data-testid="local-harness-consent-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function StepMarker({ done, n }: { done: boolean; n: number }) {
  return (
    <span
      className={
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] " +
        (done
          ? "border-foreground/40 bg-foreground/10 text-foreground"
          : "border-border/60 text-muted-foreground")
      }
      aria-hidden
    >
      {done ? "✓" : n}
    </span>
  );
}

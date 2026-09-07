import { useEffect, useState } from "react";
import { ChevronRight, FolderOpen, Laptop, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { cn } from "@mcpjam/design-system/cn";
import { track } from "@/lib/analytics";
import type {
  LocalHarnessControllerState,
  LocalHarnessPhase,
} from "@/hooks/useLocalHarnessTarget";

/**
 * One dialog, one screen, one decision.
 *
 * ── What it replaced, and why ────────────────────────────────────────────
 * A three-step wizard — Install, then Choose folder, then Authorize — that
 * asked the user to make the same decision three times without ever putting
 * the whole thing in front of them. The decision is singular: *may Claude Code
 * run on this computer, starting in this folder?* Everything else is either a
 * detail (which runtime, which policy) that belongs behind a disclosure, or
 * machinery (downloading 200 MB) that belongs after the answer rather than
 * before it.
 *
 * So: approve a NAMED runtime, then fetch it. The order matters. Downloading
 * first and asking afterwards makes the download unaskable-for; asking first
 * and downloading something else makes the approval meaningless. The pack's
 * version and digest are shown here and sent back with both the install
 * request and the grant request, and the server refuses either if they have
 * moved.
 *
 * ── The wording is load-bearing ──────────────────────────────────────────
 * "The folder is where it starts, not a sandbox" is the honest description of
 * `local-native`, and `targets.ts` forbids calling it sandboxed or isolated
 * anywhere in the product. Edits inside the folder run freely under the
 * `workspace-edits` profile; commands ask for approval in chat. Both halves
 * are stated, because stating only the first oversells the containment and
 * stating only the second undersells the reach.
 */

export type TrustDialogTrigger = "first_send" | "chip";

export interface LocalHarnessTrustDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: LocalHarnessControllerState;
  scopeKey: string;
  /** How the dialog was reached. Recorded on **Install & allow**, not on open. */
  trigger: TrustDialogTrigger;
  /** Electron only: the OS picker runs in the main process. */
  onPickWorkspace?: () => Promise<{
    workspaceGrantId: string;
    displayRoot: string;
  } | null>;
  /**
   * Warm path: the runtime is already verified, so Allow awaits the grant and
   * the original send continues. Cold path: setup starts and this is not
   * called — the user presses Send again.
   */
  onAuthorized?: () => void;
}

/** Copy for each way setup can fail. Every one leads somewhere different. */
const FAILURE_COPY: Record<string, string> = {
  verification:
    "The downloaded runtime didn't match what MCPJam expected, so it wasn't installed.",
  network: "Couldn't download the runtime.",
  disk: "Couldn't write the runtime to its install location — check free space and permissions there.",
  unknown: "Setup didn't finish.",
};

export function LocalHarnessTrustDialog({
  open,
  onOpenChange,
  controller,
  scopeKey,
  trigger,
  onPickWorkspace,
  onAuthorized,
}: LocalHarnessTrustDialogProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [changingFolder, setChangingFolder] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availability = controller.availability;
  const expectedPack = availability?.expectedPack ?? null;
  const suggested = availability?.suggestedWorkspace ?? null;
  const displayRoot =
    controller.workspace?.displayRoot ?? suggested?.displayRoot ?? null;

  // Opening the dialog fetches metadata and may register a workspace. It never
  // starts a download and never mints consent — those are what the button is
  // for, and a dialog that acted on being opened would make Cancel a lie.
  useEffect(() => {
    if (!open) return;
    track("local_harness_consent_gate_shown", { trigger });
    setError(null);
    setChangingFolder(false);
  }, [open, trigger]);

  const runtimeVerified = controller.runtimeStatus?.state === "ready";
  const canApprove =
    controller.phase !== "unavailable" &&
    controller.phase !== "needs-signin" &&
    controller.phase !== "loading" &&
    displayRoot !== null &&
    expectedPack !== null &&
    availability?.machineId != null &&
    !working;

  const primaryLabel = runtimeVerified ? "Allow" : "Install & allow";

  const useSuggestedIfNeeded = async (): Promise<boolean> => {
    if (controller.workspace !== null) return true;
    if (suggested === null) return false;
    const result = await controller.chooseWorkspace({ useSuggested: true });
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    return true;
  };

  const handleApprove = async () => {
    if (!canApprove || availability === null || expectedPack === null) return;
    setWorking(true);
    setError(null);
    try {
      if (!(await useSuggestedIfNeeded())) {
        setError(
          "Choose a folder for Claude Code to work in before allowing it.",
        );
        return;
      }
      // Recorded HERE — what was shown, at the moment it was agreed to. The
      // server re-derives every one of these and refuses to mint against a
      // difference, so this is the client's half of a comparison rather than
      // anything it is trusted about.
      const approval = controller.captureApproval({
        expectations: {
          machineId: availability.machineId!,
          packVersion: expectedPack.packVersion,
          treeDigest: expectedPack.treeDigest,
          permissionProfile: availability.permissionProfile,
          policyVersion: availability.policyVersion,
        },
        scopeKey,
      });
      if (approval === null) {
        setError("Choose a folder for Claude Code to work in.");
        return;
      }

      if (runtimeVerified) {
        // WARM: await the grant, then the caller continues the original send.
        const granted = await controller.authorize();
        if (!granted.ok) {
          setError(granted.message);
          return;
        }
        track("local_harness_consent_granted", { trigger, cold: false });
        // `onAuthorized` ALONE, and it closes the dialog itself. Calling
        // `onOpenChange(false)` first would run the owner's close path, which
        // releases the send this authorization was for — cancelling the very
        // turn it just made possible.
        onAuthorized?.();
        return;
      }

      // COLD: start setup and get out of the way. The composer reports
      // progress; the draft stays; the user presses Send again when it is
      // ready. Deliberately no queued send — a prompt that fires itself
      // minutes later, after a download, is not what anybody pressed.
      const started = await controller.startInstall();
      if (!started.ok) {
        setError(started.message);
        return;
      }
      track("local_harness_runtime_install_started", { trigger });
      onOpenChange(false);
    } finally {
      setWorking(false);
    }
  };

  const handlePick = async () => {
    if (!onPickWorkspace) return;
    setError(null);
    // The Electron side can refuse (an unreadable directory, a path outside
    // what the main process will register). Called as `void handlePick()`, an
    // uncaught rejection here left the dialog looking as though the click had
    // done nothing at all — no error, no recovery, no picker.
    let picked: Awaited<ReturnType<NonNullable<typeof onPickWorkspace>>>;
    try {
      picked = await onPickWorkspace();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "That folder could not be registered.",
      );
      return;
    }
    if (picked === null) return;
    // The main process already registered it and handed back an opaque id and
    // a display root. Re-registering would mean sending the tilde-shortened
    // DISPLAY string as a path — which is not a path, and which this renderer
    // is not allowed to send anyway.
    controller.adoptWorkspace(picked);
  };

  const handleTypedPath = async () => {
    const path = pathDraft.trim();
    if (path.length === 0) return;
    setError(null);
    const result = await controller.chooseWorkspace({ path });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setChangingFolder(false);
    setPathDraft("");
  };

  // A disabled button with nothing on screen explaining it is the failure this
  // dialog is otherwise arranged to avoid, so every reason `canApprove` can be
  // false for has copy — including the two that are facts about the machine
  // rather than states of the flow.
  const blockingCopy =
    blockingReason(controller.phase, controller.reason) ??
    (expectedPack === null
      ? "MCPJam hasn't published a Claude Code runtime for this machine's " +
        "operating system and processor, so there is nothing to install."
      : availability !== null && availability.machineId == null
        ? "This Inspector couldn't establish an identity for this machine, so " +
          "it can't bind an authorization to it. Restart the Inspector, or " +
          "check that it can write to its own state directory."
        : displayRoot === null
          ? "Choose a folder for Claude Code to work in."
          : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="local-harness-trust-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Laptop className="size-4 text-muted-foreground" aria-hidden />
            {displayRoot
              ? `Run Claude Code in ${displayRoot}?`
              : "Run Claude Code on this machine?"}
          </DialogTitle>
          <DialogDescription className="text-left leading-relaxed">
            Claude Code will run on this computer as your user account. The
            folder is where it starts, not a sandbox — anything you can read or
            change, it can. Edits inside the folder run freely; commands ask for
            approval in chat.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <FolderOpen
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span
              className="truncate font-mono text-xs text-foreground"
              data-testid="local-harness-trust-folder"
            >
              {displayRoot ?? "No folder chosen"}
            </span>
          </div>
          {onPickWorkspace ? (
            <Button size="sm" variant="outline" onClick={() => void handlePick()}>
              Change…
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setChangingFolder((v) => !v)}
            >
              Change…
            </Button>
          )}
        </div>

        {changingFolder && !onPickWorkspace ? (
          <div className="flex items-center gap-2">
            <Input
              value={pathDraft}
              onChange={(event) => setPathDraft(event.target.value)}
              placeholder="/Users/you/code/your-project"
              className="font-mono text-xs"
              data-testid="local-harness-trust-path"
            />
            <Button size="sm" onClick={() => void handleTypedPath()}>
              Use
            </Button>
          </div>
        ) : null}

        <button
          type="button"
          className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setDetailsOpen((v) => !v)}
          aria-expanded={detailsOpen}
        >
          <ChevronRight
            className={cn("size-3 transition-transform", detailsOpen && "rotate-90")}
            aria-hidden
          />
          Details
        </button>
        {detailsOpen ? (
          <dl
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground"
            data-testid="local-harness-trust-details"
          >
            <dt>Runtime</dt>
            <dd className="font-mono">
              {/* The pack this build EXPECTS, readable before it is downloaded;
                  after a grant, the runtime the server actually resolved. */}
              {controller.consent?.runtime.packVersion ??
                expectedPack?.packVersion ??
                "unknown"}{" "}
              ·{" "}
              {(
                controller.consent?.runtime.digest ?? expectedPack?.treeDigest
              )?.slice(0, 17) ?? "no digest"}
              …
            </dd>
            <dt>Permissions</dt>
            <dd>edits in folder, commands ask</dd>
            <dt>Policy</dt>
            <dd className="font-mono">{availability?.policyVersion ?? "—"}</dd>
            <dt>Expires</dt>
            <dd>12 hours after you allow it</dd>
          </dl>
        ) : null}

        {blockingCopy ? (
          <p
            className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
            data-testid="local-harness-trust-blocked"
          >
            {blockingCopy}
          </p>
        ) : null}
        {error ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            data-testid="local-harness-trust-error"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              // Cancel starts nothing and mints nothing. The draft is
              // untouched, and Send remains a way back in.
              controller.cancelApproval();
              track("local_harness_consent_denied", { trigger });
              onOpenChange(false);
            }}
            disabled={working}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleApprove()}
            disabled={!canApprove}
            data-testid="local-harness-trust-approve"
          >
            {working ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
            ) : null}
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The one thing standing in the way, when it is not something Allow fixes. */
function blockingReason(
  phase: LocalHarnessPhase,
  reason: string | null,
): string | null {
  switch (phase) {
    case "needs-signin":
      return (
        reason ??
        "Sign in to authorize Claude Code to run on this machine."
      );
    case "unavailable":
      return (
        reason ??
        "This Inspector can't run Claude Code on this machine, so turns run hosted."
      );
    case "failed":
      return FAILURE_COPY[installFailureReason(reason)] ?? FAILURE_COPY.unknown;
    case "interrupted":
      return "Setup was interrupted. Retry to continue.";
    case "loading":
      // Never a bare `null`. `loading` disables Allow (see `canApprove`), and
      // the fallbacks below only speak when the pack, the machine id or the
      // folder is missing — so a load that carries no message left the button
      // dead with nothing on screen explaining it. The member query resolving
      // is exactly that case.
      return reason ?? "Checking this machine — one moment.";
    default:
      return null;
  }
}

/** Best-effort classification when only a message survived. */
function installFailureReason(message: string | null): string {
  if (message === null) return "unknown";
  if (/didn't match|does not match|digest|signature/i.test(message)) {
    return "verification";
  }
  if (/download|network|offline|responded \d{3}/i.test(message)) return "network";
  if (/space|permission|ENOSPC|EACCES/i.test(message)) return "disk";
  return "unknown";
}

export { FAILURE_COPY as LOCAL_HARNESS_FAILURE_COPY };

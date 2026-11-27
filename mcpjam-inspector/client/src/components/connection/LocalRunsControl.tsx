import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { describeConvexFailure } from "@/lib/convex-error";

const SERVER_COPY = {
  allow: {
    title: "Allow local runs for this server?",
    body: "Members' local apps will receive the project accounts' access tokens. A token already sent keeps working until it expires, even after you stop local runs.",
    action: "Allow local runs",
    done: "Local runs allowed.",
    failed: "Could not allow local runs. Try again.",
  },
  stop: {
    title: "Stop local runs for this server?",
    body: "Members' local apps stop receiving these accounts' tokens from their next connection or run. A token already sent keeps working until it expires.",
    action: "Stop local runs",
    done: "Local runs stopped.",
    failed: "Could not stop local runs. Try again.",
  },
  allowedNote:
    "Members' local apps can receive these accounts' access tokens unless your organization's export policy blocks it.",
};

/** A web client's accounts are saved sign-ins, so nothing here says token. */
const CLIENT_COPY: typeof SERVER_COPY = {
  allow: {
    title: "Allow local runs for this client?",
    body: "Members' local apps will receive the project accounts' saved sign-ins. A sign-in already sent stays signed in until the site signs it out, even after you stop local runs.",
    action: "Allow local runs",
    done: "Local runs allowed.",
    failed: "Couldn't allow local runs. Try again.",
  },
  stop: {
    title: "Stop local runs for this client?",
    body: "Members' local apps stop receiving these accounts' sign-ins from their next run. A sign-in already sent stays signed in until the site signs it out.",
    action: "Stop local runs",
    done: "Local runs stopped.",
    failed: "Couldn't stop local runs. Try again.",
  },
  allowedNote: "Members' local apps can use these accounts' saved sign-ins.",
};

/**
 * A project admin's switch for whether members' local apps (npx, the desktop
 * app) may receive a shared server's account tokens. A server shared before
 * this switch existed starts off, because its accounts were shared under the
 * promise that no token leaves MCPJam; the backend refuses local delivery
 * until an admin turns it on. Both directions confirm first.
 */
export function LocalRunsControl({
  allowed,
  allowedNote,
  listVersion,
  onChange,
  noun = "server",
}: {
  allowed: boolean;
  /** Replaces the note while allowed, for a caller where only some of the accounts allow it. */
  allowedNote?: string;
  /** Changes each time the account list reloads, so the switch knows its save was reconciled. */
  listVersion?: number;
  onChange: (allowed: boolean) => Promise<void>;
  /** What the accounts belong to: an MCP server's, or a web client's sign-ins. */
  noun?: "server" | "client";
}) {
  const words = noun === "client" ? CLIENT_COPY : SERVER_COPY;
  const switchId = useId();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  // The value just saved, until the refetched `allowed` shows it or the list
  // reloads, so the switch can't offer the same change twice in between. A
  // reload that shows another value (another admin changed it) also ends it.
  const [saved, setSaved] = useState<{
    value: boolean;
    version: number | undefined;
  } | null>(null);
  useEffect(() => {
    if (saved && (saved.value === allowed || saved.version !== listVersion))
      setSaved(null);
  }, [allowed, listVersion, saved]);
  // The newest list version, read when the save completes: a reload that
  // landed while the write was pending isn't the one the save triggered.
  const listVersionRef = useRef(listVersion);
  useLayoutEffect(() => {
    listVersionRef.current = listVersion;
  }, [listVersion]);
  const copy = allowed ? words.stop : words.allow;
  const apply = async () => {
    setSaving(true);
    try {
      await onChange(!allowed);
      setSaved({ value: !allowed, version: listVersionRef.current });
      toast.success(copy.done);
    } catch (failure) {
      const refusal = describeConvexFailure(failure, copy.failed);
      toast.error(refusal.refusal ? refusal.message : copy.failed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={switchId} className="text-sm font-medium">
          Allow local runs
        </Label>
        <p className="text-xs text-muted-foreground">
          {allowed
            ? (allowedNote ?? words.allowedNote)
            : "Members' hosted runs use these accounts. Turn this on so their local apps can too."}
        </p>
      </div>
      <Switch
        id={switchId}
        checked={allowed}
        disabled={saving || saved !== null}
        onCheckedChange={() => setConfirming(true)}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void apply()}>
              {copy.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@mcpjam/design-system/button";
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
import { useCursorHostEnabled } from "@/hooks/useCursorHostEnabled";
import { useCursorProvider } from "@/hooks/useCursorProvider";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";
import { ProviderRow } from "./ProviderRow";
import { CursorKeyDialog } from "./CursorKeyDialog";

type Props = {
  organizationId: string;
  isAdmin: boolean;
  showUnconfigured: boolean;
};
export function CursorProviderSettings(props: Props) {
  return useCursorHostEnabled() ? (
    <CursorProvider key={props.organizationId} {...props} />
  ) : null;
}
function CursorProvider({ organizationId, isAdmin, showUnconfigured }: Props) {
  const provider = useCursorProvider(organizationId);
  const [configure, setConfigure] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const view = provider.view;
  if (!view || (isAdmin && !view.configured && !showUnconfigured)) return null;
  const refresh = async () => {
    setBusy(true);
    try {
      const result = await provider.refreshModels();
      if (result.applied) toast.success("Cursor models updated.");
      else
        toast.error(
          "Could not refresh Cursor models. The previous list is still available. Try again.",
        );
    } catch (cause) {
      toast.error(
        convexErrMessage(cause, "Could not refresh Cursor models. Try again."),
      );
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await provider.removeKey();
      setRemoving(false);
      toast.success("Cursor key removed.");
    } catch (cause) {
      toast.error(
        convexErrMessage(cause, "Could not remove the Cursor key. Try again."),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ProviderRow
        name="Cursor"
        disabled={busy}
        logo="/cursor_logo.png"
        configured={view.configured}
        isAdmin={isAdmin}
        onConfigure={() => setConfigure(true)}
        onRemove={() => setRemoving(true)}
        detail={
          isAdmin && view.identity ? (
            <p className="text-xs text-muted-foreground">
              {view.identity.label} · {view.modelCount ?? 0} models
              {view.modelsRefreshedAt
                ? ` · Updated ${formatDistanceToNow(view.modelsRefreshedAt, { addSuffix: true })}`
                : " · Models have not synced yet"}
              {view.modelsRefreshStatus === "failed" && (
                <span className="block text-destructive">
                  Refresh failed. The previous list is still available.
                </span>
              )}
            </p>
          ) : undefined
        }
        extraAction={
          isAdmin && view.configured ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Refresh Cursor models"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          ) : undefined
        }
      />
      {configure && (
        <CursorKeyDialog
          view={view}
          checkKey={provider.checkKey}
          saveKey={provider.saveKey}
          onClose={() => setConfigure(false)}
        />
      )}
      <AlertDialog
        open={removing}
        onOpenChange={(open) => {
          if (!busy) setRemoving(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Cursor key?</AlertDialogTitle>
            <AlertDialogDescription>
              Cursor and Cursor CLI runs in this organization stop until an
              admin adds a key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {busy ? "Removing..." : "Remove key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

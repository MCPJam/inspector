import { useCallback, useRef, useState } from "react";
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

/**
 * Shape passed by `MCPAppsRenderer.onConfirmDownload` — describes the file a
 * widget is asking the host to download so the user can make an informed
 * allow/deny decision.
 */
export interface DownloadConfirmationInfo {
  kind: "resource" | "resource_link";
  filename?: string;
  mimeType?: string;
  uri?: string;
}

interface PendingRequest {
  info: DownloadConfirmationInfo;
  resolve: (approved: boolean) => void;
}

/**
 * SEP-1865 `ui/download-file`: the host SHOULD confirm before a widget-initiated
 * download runs. This hook supplies the `onConfirmDownload` async callback for
 * `MCPAppsRenderer` plus the modal element to render — the promise returned to
 * the renderer resolves when the user clicks Download (true) or Cancel (false),
 * so a denial surfaces to the widget as a JSON-RPC error rather than a silent
 * drop. Only one prompt is shown at a time; a second request while one is open
 * is auto-denied (the widget can re-request).
 */
export function useDownloadConfirmation(): {
  confirmDownload: (info: DownloadConfirmationInfo) => Promise<boolean>;
  dialog: React.ReactNode;
} {
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const pendingRef = useRef<PendingRequest | null>(null);
  pendingRef.current = pending;

  const settle = useCallback((approved: boolean) => {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = null;
    setPending(null);
    current.resolve(approved);
  }, []);

  const confirmDownload = useCallback(
    (info: DownloadConfirmationInfo): Promise<boolean> => {
      // Serialize prompts: if one is already open, deny the newcomer rather
      // than stacking dialogs. The widget receives an error and can retry.
      if (pendingRef.current) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        const request = { info, resolve };
        pendingRef.current = request;
        setPending(request);
      });
    },
    []
  );

  const info = pending?.info;
  const label = info?.filename || info?.uri || "this file";
  const isLink = info?.kind === "resource_link";

  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        // Closing via overlay/escape counts as a denial.
        if (!open) settle(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Download file?</AlertDialogTitle>
          <AlertDialogDescription>
            This MCP App wants to {isLink ? "open a link to download" : "download"}{" "}
            <span className="font-medium break-all">{label}</span>
            {info?.mimeType ? ` (${info.mimeType})` : ""}. Only continue if you
            trust this app.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => settle(true)}>
            Download
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { confirmDownload, dialog };
}

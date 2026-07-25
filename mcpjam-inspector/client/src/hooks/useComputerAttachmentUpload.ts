import { useCallback } from "react";
import {
  useComputersDataPlaneConfig,
  useMintTerminalToken,
  useReserveComputer,
} from "@/hooks/useProjectComputer";
import { toTerminalWsBase } from "@/lib/computer-terminal-connection";
import {
  uploadAttachmentsToComputer,
  type ComputerAttachmentNoteEntry,
} from "@/lib/computer-attachments";

/**
 * React binding for the chat-attachment → computer-filesystem flow (COMP-14).
 * Composes the SAME primitives the Shell uses — `getOrReserveComputer`,
 * `mintTerminalToken`, and the data-plane resolution that decides whether the
 * upload targets this server or a deployed remote data plane — so there is one
 * reservation path and one upload route. Pure orchestration lives in
 * `lib/computer-attachments.ts`.
 *
 * `available` is false until the data-plane config has resolved to a usable
 * plane; callers should fall back to plain inline-only attachments (with a
 * toast) rather than dropping the send silently.
 */
export function useComputerAttachmentUpload({
  projectId,
  isAuthenticated,
}: {
  projectId: string | null;
  isAuthenticated: boolean;
}) {
  const effectiveProjectId = isAuthenticated ? projectId : null;
  const reserve = useReserveComputer();
  const mintToken = useMintTerminalToken();

  // Mirror useComputerTerminal's plane resolution: local plane ⇒ page-origin
  // upload; remote plane ⇒ convert its URL to the ws base the upload URL
  // builder expects; neither ⇒ computers unusable from this inspector.
  const dataPlane = useComputersDataPlaneConfig();
  const remoteWsBase = dataPlane?.remoteDataPlaneUrl
    ? toTerminalWsBase(dataPlane.remoteDataPlaneUrl)
    : undefined;
  const uploadBaseUrl =
    dataPlane && !dataPlane.localConfigured ? remoteWsBase : undefined;
  const available =
    !!effectiveProjectId &&
    dataPlane !== undefined &&
    (dataPlane.localConfigured || !!remoteWsBase);

  const uploadAttachments = useCallback(
    async (files: File[]): Promise<ComputerAttachmentNoteEntry[]> => {
      if (!effectiveProjectId) {
        throw new Error("Sign in and select a project to use the computer.");
      }
      if (dataPlane === undefined) {
        throw new Error("Computers are still loading — try again in a moment.");
      }
      if (!dataPlane.localConfigured && !remoteWsBase) {
        throw new Error("Computers are not available on this server.");
      }
      return await uploadAttachmentsToComputer(
        { reserve, mintToken },
        {
          projectId: effectiveProjectId,
          files,
          ...(uploadBaseUrl ? { uploadBaseUrl } : {}),
        },
      );
    },
    [effectiveProjectId, dataPlane, remoteWsBase, uploadBaseUrl, reserve, mintToken],
  );

  return { available, uploadAttachments };
}

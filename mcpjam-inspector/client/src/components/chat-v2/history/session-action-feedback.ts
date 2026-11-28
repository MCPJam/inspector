import { ConvexError } from "convex/values";
import { toast } from "@/lib/toast";

export type SessionRowAction =
  "archive" | "unarchive" | "pin" | "unpin" | "share" | "unshare";

const FAILURE_COPY: Record<SessionRowAction, string> = {
  archive: "Couldn't archive the session. Try again.",
  unarchive: "Couldn't restore the session. Try again.",
  pin: "Couldn't pin the session. Try again.",
  unpin: "Couldn't unpin the session. Try again.",
  share: "Couldn't share the session with your project. Try again.",
  unshare: "Couldn't stop sharing the session. Try again.",
};

function refusalMessage(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (typeof data === "object" && data !== null && "message" in data) {
    const { message } = data;
    return typeof message === "string" && message.trim() ? message : null;
  }
  return null;
}

export function showSessionActionFailure(
  action: SessionRowAction,
  error: unknown,
): void {
  toast.error(refusalMessage(error) ?? FAILURE_COPY[action]);
}

/**
 * Confirms row actions whose result is not visible in place: share and
 * unshare move the row between sections, and archive removes it.
 */
export function showSessionActionSuccess(
  action: SessionRowAction,
  { undoArchive }: { undoArchive: () => Promise<void> },
): void {
  switch (action) {
    case "share":
      toast.success("Shared with your team's project. It's now in Shared Sessions.");
      return;
    case "unshare":
      toast.success("Stopped sharing. It's back in your Sessions.");
      return;
    case "archive": {
      const undo = async () => {
        try {
          await undoArchive();
        } catch (error) {
          toast.error(refusalMessage(error) ?? FAILURE_COPY.unarchive, {
            action: { label: "Try again", onClick: () => void undo() },
          });
        }
      };
      toast.success("Session archived.", {
        action: { label: "Undo", onClick: () => void undo() },
      });
      return;
    }
    default:
      return;
  }
}

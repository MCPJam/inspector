import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { GuestSignInButton } from "@/components/auth/GuestSignInMessage";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";
import { requestProjectAccessRef } from "./access-request-api";

/** Matches the backend's dedupe window: a repeat inside it records nothing. */
const REQUEST_WINDOW_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "mcpjam-project-access-requests";

/**
 * Per-viewer memory of sent requests, so a reload inside the window still
 * reads "Request sent". The backend answers `sent` for every project id, so
 * remembering the click reveals nothing about the project. Storage is a
 * convenience: every access is try/caught and the button works without it.
 */
function readSent(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const now = Date.now();
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && now - value < REQUEST_WINDOW_MS) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function rememberSent(key: string): number {
  const now = Date.now();
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readSent(), [key]: now }),
    );
  } catch {
    // Blocked storage only loses the reload memory; the request already went.
  }
  return now;
}

/**
 * The primary action on the unavailable-project screen. It renders the same
 * for every project id: the request mutation answers `sent` whether or not
 * the project exists, so nothing here branches on the project.
 */
export function RequestAccessAction({ projectId }: { projectId: string }) {
  const { user, isLoading } = useInspectorAuth();
  const ready = useDbUserReady();
  if (isLoading) return null;
  if (!user) {
    return (
      <GuestSignInButton
        size="sm"
        label="Sign in to ask for access"
        location="project_route_inaccessible"
      />
    );
  }
  // Until the Convex user row exists the request would fail with "User not
  // found", which a colleague who just signed up from this link would hit.
  if (!ready) {
    return (
      <Button type="button" size="sm" disabled>
        Ask for access
      </Button>
    );
  }
  return (
    <SignedInRequestButton
      key={`${user.id}:${projectId}`}
      storageKey={`${user.id}:${projectId}`}
      projectId={projectId}
    />
  );
}

function SignedInRequestButton({
  projectId,
  storageKey,
}: {
  projectId: string;
  storageKey: string;
}) {
  const requestAccess = useMutation(requestProjectAccessRef);
  const [sentAt, setSentAt] = useState<number | null>(
    () => readSent()[storageKey] ?? null,
  );
  const [sending, setSending] = useState(false);
  const sent = sentAt !== null;

  // The window can end while this screen stays open; offer a new request then.
  useEffect(() => {
    if (sentAt === null) return;
    const timer = window.setTimeout(
      () => setSentAt(null),
      sentAt + REQUEST_WINDOW_MS - Date.now(),
    );
    return () => window.clearTimeout(timer);
  }, [sentAt]);

  const send = async () => {
    setSending(true);
    try {
      await requestAccess({ projectId });
      setSentAt(rememberSent(storageKey));
    } catch (error) {
      toast.error(
        convexErrMessage(error, "Could not send the request. Try again."),
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      disabled={sent || sending}
      onClick={() => void send()}
    >
      {sent ? "Request sent" : sending ? "Sending request…" : "Ask for access"}
    </Button>
  );
}
